import { TestingModule } from '@nestjs/testing';
import { DataSource, IsNull, Repository } from 'typeorm';
import { InvalidRefreshTokenException } from '../../src/auth/auth.errors';
import { AuthModule } from '../../src/auth/auth.module';
import { RefreshToken } from '../../src/auth/tokens/refresh-token.entity';
import {
  hashToken,
  RefreshTokenService,
} from '../../src/auth/tokens/refresh-token.service';
import { UsersService } from '../../src/users/users.service';
import { createTestModule } from '../utils/create-test-module';
import { resetDatabase } from '../utils/database';

describe('RefreshTokenService (integration)', () => {
  let moduleRef: TestingModule;
  let service: RefreshTokenService;
  let tokens: Repository<RefreshToken>;
  let dataSource: DataSource;
  let userId: string;

  const activeTokensIn = (familyId: string): Promise<number> =>
    tokens.countBy({ familyId, revokedAt: IsNull() });

  beforeAll(async () => {
    moduleRef = await createTestModule([AuthModule]);
    service = moduleRef.get(RefreshTokenService);
    dataSource = moduleRef.get(DataSource);
    tokens = dataSource.getRepository(RefreshToken);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    const user = await moduleRef.get(UsersService).create({
      email: 'ada@example.com',
      passwordHash: 'x',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    userId = user.id;
  });

  afterAll(() => moduleRef.close());

  it('stores only a hash of the token', async () => {
    const { token } = await service.issue(userId);

    const [row] = await tokens.find();
    expect(row?.tokenHash).toBe(hashToken(token));
    expect(row?.tokenHash).not.toContain(token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rotates: the new token works, the old one is revoked and linked', async () => {
    const first = await service.issue(userId);
    const second = await service.rotate(first.token);

    expect(second.token).not.toBe(first.token);
    expect(second.userId).toBe(userId);

    const old = await tokens.findOneByOrFail({
      tokenHash: hashToken(first.token),
    });
    const next = await tokens.findOneByOrFail({
      tokenHash: hashToken(second.token),
    });
    expect(old.revokedAt).not.toBeNull();
    expect(old.replacedById).toBe(next.id);
    expect(next.familyId).toBe(old.familyId);

    await expect(service.rotate(second.token)).resolves.toBeDefined();
  });

  it('revokes the whole family when a rotated token is reused', async () => {
    const first = await service.issue(userId);
    const second = await service.rotate(first.token);

    await expect(service.rotate(first.token)).rejects.toThrow(
      InvalidRefreshTokenException,
    );

    // The legitimate latest token is revoked too: the session is compromised.
    await expect(service.rotate(second.token)).rejects.toThrow(
      InvalidRefreshTokenException,
    );
    await expect(activeTokensIn(second.familyId)).resolves.toBe(0);
  });

  it('rejects unknown tokens', async () => {
    await expect(service.rotate('never-issued')).rejects.toThrow(
      InvalidRefreshTokenException,
    );
  });

  it('rejects expired tokens', async () => {
    const { token } = await service.issue(userId);
    await tokens.update(
      { tokenHash: hashToken(token) },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    await expect(service.rotate(token)).rejects.toThrow(
      InvalidRefreshTokenException,
    );
  });

  it('serialises concurrent rotations of the same token (SELECT ... FOR UPDATE)', async () => {
    const { token } = await service.issue(userId);

    const attempts = await Promise.allSettled([
      service.rotate(token),
      service.rotate(token),
      service.rotate(token),
    ]);

    // Without the row lock, every attempt could read the token as active and
    // mint its own successor, forking one session into several valid ones.
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const rows = await tokens.find();
    const successors = rows.filter((row) => row.tokenHash !== hashToken(token));
    expect(successors).toHaveLength(1);

    // The losers presented an already-rotated token: treated as reuse.
    await expect(activeTokensIn(rows[0]?.familyId ?? '')).resolves.toBe(0);
  });

  it('revoke() ends one session and ignores unknown tokens', async () => {
    const sessionA = await service.issue(userId);
    const sessionB = await service.issue(userId);

    await service.revoke(sessionA.token);
    await expect(service.revoke('unknown')).resolves.toBeUndefined();

    await expect(service.rotate(sessionA.token)).rejects.toThrow(
      InvalidRefreshTokenException,
    );
    await expect(service.rotate(sessionB.token)).resolves.toBeDefined();
  });

  it('revokeAllForUser() ends every session', async () => {
    const sessionA = await service.issue(userId);
    const sessionB = await service.issue(userId);

    await service.revokeAllForUser(userId);

    await expect(service.rotate(sessionA.token)).rejects.toThrow(
      InvalidRefreshTokenException,
    );
    await expect(service.rotate(sessionB.token)).rejects.toThrow(
      InvalidRefreshTokenException,
    );
  });

  it('deletes tokens when their user is deleted', async () => {
    await service.issue(userId);

    await dataSource.query('DELETE FROM users WHERE id = $1', [userId]);

    await expect(tokens.count()).resolves.toBe(0);
  });

  it('deletes tokens only once they are past retention', async () => {
    await service.issue(userId); // active: kept
    const revoked = await service.issue(userId);
    await service.revoke(revoked.token);
    await service.issue(userId);
    await dataSource.query(
      `UPDATE refresh_tokens SET revoked_at = now() - interval '31 days'
        WHERE revoked_at IS NOT NULL`,
    );

    await expect(service.deleteFinished(30)).resolves.toBe(1);
    await expect(tokens.count()).resolves.toBe(2);
  });
});
