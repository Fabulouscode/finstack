import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { PlatformRoleDto } from '../src/admin/dto/admin.dto';
import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import { UserResponseDto } from '../src/users/dto/user-response.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';

describe('Platform roles (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let admin: AuthResponseDto;
  let customer: AuthResponseDto;
  let customerWallet: WalletResponseDto;

  const as = (
    token: string,
    method: 'get' | 'post',
    path: string,
  ): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const reason = { reason: 'Team change' };

  /** Registers a user and gives them a staff role through the API. */
  const staff = async (
    email: string,
    role: string,
  ): Promise<AuthResponseDto> => {
    const session = await registerUser(app, email);
    expectStatus(
      await as(
        admin.tokens.accessToken,
        'post',
        `/v1/admin/users/${session.user.id}/role`,
      ).send({ role, ...reason }),
      200,
      `make ${role}`,
    );
    return session;
  };

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '100' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    await resetDatabase(dataSource);

    admin = await registerUser(app, 'admin@example.com');
    await dataSource.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [
      admin.user.id,
    ]);
    customer = await registerUser(app, 'ada@example.com');
    customerWallet = expectStatus(
      await as(customer.tokens.accessToken, 'post', '/v1/wallets').send({}),
      201,
      'wallet',
    ).body as WalletResponseDto;
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  it('gives support read-only access', async () => {
    const support = await staff('support@example.com', 'support');
    const token = support.tokens.accessToken;

    await as(token, 'get', '/v1/admin/overview').expect(200);
    await as(token, 'get', `/v1/admin/users/${customer.user.id}`).expect(200);
    await as(token, 'get', `/v1/admin/wallets/${customerWallet.id}`).expect(
      200,
    );
    await as(token, 'get', '/v1/admin/audit-logs').expect(200);

    const suspend = await as(
      token,
      'post',
      `/v1/admin/users/${customer.user.id}/suspend`,
    ).send(reason);
    expect(suspend.status).toBe(403);
    expect(suspend.body).toMatchObject({
      code: 'FORBIDDEN',
      detail: 'This requires the "users:manage" platform permission',
    });
    await as(token, 'post', '/v1/admin/fee-rules')
      .send({ operation: 'payout', currency: 'USD', fixedAmount: 1 })
      .expect(403);
  });

  it('lets risk stop bad actors but not price or move money', async () => {
    const risk = await staff('risk@example.com', 'risk');
    const token = risk.tokens.accessToken;

    await as(token, 'post', `/v1/admin/wallets/${customerWallet.id}/freeze`)
      .send(reason)
      .expect(200);
    await as(token, 'post', `/v1/admin/users/${customer.user.id}/suspend`)
      .send(reason)
      .expect(200);
    await as(token, 'post', '/v1/admin/limit-rules')
      .send({ operation: 'payout', currency: 'USD', maxPerTransaction: 1_000 })
      .expect(201);

    await as(token, 'post', '/v1/admin/fee-rules')
      .send({ operation: 'payout', currency: 'USD', fixedAmount: 1 })
      .expect(403);
    await as(token, 'post', '/v1/fx/rates')
      .send({ base: 'USD', quote: 'NGN', rate: '1500' })
      .expect(403);
  });

  it('lets finance price and move money but not suspend people', async () => {
    const finance = await staff('finance@example.com', 'finance');
    const token = finance.tokens.accessToken;

    await as(token, 'post', '/v1/admin/fee-rules')
      .send({ operation: 'payout', currency: 'USD', fixedAmount: 100 })
      .expect(201);
    await as(token, 'post', '/v1/fx/rates')
      .send({ base: 'USD', quote: 'NGN', rate: '1500' })
      .expect(201);
    await as(token, 'get', '/v1/admin/reconciliation/runs').expect(200);

    await as(token, 'post', `/v1/admin/users/${customer.user.id}/suspend`)
      .send(reason)
      .expect(403);
    await as(token, 'post', `/v1/admin/wallets/${customerWallet.id}/freeze`)
      .send(reason)
      .expect(403);
  });

  it('keeps customers out of every admin endpoint', async () => {
    for (const path of [
      '/v1/admin/overview',
      '/v1/admin/users',
      '/v1/admin/audit-logs',
      '/v1/admin/roles',
    ]) {
      await as(customer.tokens.accessToken, 'get', path).expect(403);
    }
  });

  describe('role management', () => {
    it('is admin-only, audited and immediate', async () => {
      const support = await staff('support@example.com', 'support');
      await as(support.tokens.accessToken, 'get', '/v1/admin/overview').expect(
        200,
      );

      // Staff can't hand out roles, even read-only ones.
      await as(
        support.tokens.accessToken,
        'post',
        `/v1/admin/users/${customer.user.id}/role`,
      )
        .send({ role: 'support', ...reason })
        .expect(403);

      // Demoted: the still-valid token loses access at once.
      const demoted = expectStatus(
        await as(
          admin.tokens.accessToken,
          'post',
          `/v1/admin/users/${support.user.id}/role`,
        ).send({ role: 'user', reason: 'Left the team' }),
        200,
        'demote',
      ).body as UserResponseDto;
      expect(demoted.role).toBe('user');
      await as(support.tokens.accessToken, 'get', '/v1/admin/overview').expect(
        403,
      );

      const entries = await dataSource.query<{ metadata: object }[]>(
        `SELECT metadata FROM audit_logs WHERE action = 'user.role_changed' AND target_id = $1 ORDER BY created_at`,
        [support.user.id],
      );
      expect(entries.map((e) => e.metadata)).toEqual([
        { from: 'user', to: 'support', reason: 'Team change' },
        { from: 'support', to: 'user', reason: 'Left the team' },
      ]);

      const roles = (
        await as(admin.tokens.accessToken, 'get', '/v1/admin/roles').expect(200)
      ).body as PlatformRoleDto[];
      expect(
        roles.find((r) => String(r.role) === 'support')?.permissions,
      ).toContain('users:read');
    });

    it('never locks the platform out, even when admins race', async () => {
      const self = await as(
        admin.tokens.accessToken,
        'post',
        `/v1/admin/users/${admin.user.id}/role`,
      ).send({ role: 'user', ...reason });
      expect(self.body).toMatchObject({ code: 'CANNOT_CHANGE_OWN_ROLE' });

      // Two admins demote each other at the same moment: one must remain.
      const second = await staff('second@example.com', 'admin');
      const results = await Promise.all([
        as(
          admin.tokens.accessToken,
          'post',
          `/v1/admin/users/${second.user.id}/role`,
        ).send({ role: 'user', ...reason }),
        as(
          second.tokens.accessToken,
          'post',
          `/v1/admin/users/${admin.user.id}/role`,
        ).send({ role: 'user', ...reason }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)?.body).toMatchObject({
        code: 'LAST_ADMIN',
      });
      const [row] = await dataSource.query<{ count: number }[]>(
        `SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND status = 'active'`,
      );
      expect(row?.count).toBe(1);
    });

    it('never suspends the last admin, even when admins race', async () => {
      const second = await staff('second@example.com', 'admin');
      const results = await Promise.all([
        as(
          admin.tokens.accessToken,
          'post',
          `/v1/admin/users/${second.user.id}/suspend`,
        ).send(reason),
        as(
          second.tokens.accessToken,
          'post',
          `/v1/admin/users/${admin.user.id}/suspend`,
        ).send(reason),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('lets only admins suspend staff', async () => {
      const risk = await staff('risk@example.com', 'risk');
      const finance = await staff('finance@example.com', 'finance');

      const refused = await as(
        risk.tokens.accessToken,
        'post',
        `/v1/admin/users/${finance.user.id}/suspend`,
      ).send(reason);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        detail: 'This requires the "roles:manage" platform permission',
      });
      await as(
        admin.tokens.accessToken,
        'post',
        `/v1/admin/users/${finance.user.id}/suspend`,
      )
        .send(reason)
        .expect(200);
    });
  });
});
