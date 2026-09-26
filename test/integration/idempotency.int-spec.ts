import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { userOwner } from '../../src/common/owner/owner';
import { IdempotencyKey } from '../../src/idempotency/idempotency-key.entity';
import {
  IdempotencyKeyReusedException,
  IdempotencyRequestInProgressException,
} from '../../src/idempotency/idempotency.errors';
import { IdempotencyModule } from '../../src/idempotency/idempotency.module';
import {
  IdempotencyService,
  RequestFingerprint,
} from '../../src/idempotency/idempotency.service';
import { OrganizationsModule } from '../../src/organizations/organizations.module';
import { UsersModule } from '../../src/users/users.module';
import { UsersService } from '../../src/users/users.service';
import { createTestModule } from '../utils/create-test-module';
import { resetDatabase } from '../utils/database';

describe('IdempotencyService (integration)', () => {
  let moduleRef: TestingModule;
  let service: IdempotencyService;
  let dataSource: DataSource;
  let request: RequestFingerprint;

  beforeAll(async () => {
    moduleRef = await createTestModule([
      UsersModule,
      OrganizationsModule,
      IdempotencyModule,
    ]);
    service = moduleRef.get(IdempotencyService);
    dataSource = moduleRef.get(DataSource);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    const user = await moduleRef.get(UsersService).create({
      email: 'ada@example.com',
      passwordHash: 'x',
      firstName: 'A',
      lastName: 'L',
    });
    request = {
      owner: userOwner(user.id),
      key: 'key-1',
      method: 'POST',
      path: '/v1/transfers',
      requestHash: 'a'.repeat(64),
    };
  });

  afterAll(() => moduleRef.close());

  it('lets the first request execute and replays the stored response afterwards', async () => {
    const first = await service.begin(request);
    expect(first.kind).toBe('execute');
    if (first.kind !== 'execute') return;

    await service.complete(first.recordId, 201, { id: 'txn-1' });

    await expect(service.begin(request)).resolves.toEqual({
      kind: 'replay',
      status: 201,
      body: { id: 'txn-1' },
    });
  });

  it('rejects the same key with a different request', async () => {
    await service.begin(request);

    await expect(
      service.begin({ ...request, requestHash: 'b'.repeat(64) }),
    ).rejects.toThrow(IdempotencyKeyReusedException);
    await expect(
      service.begin({ ...request, path: '/v1/other' }),
    ).rejects.toThrow(IdempotencyKeyReusedException);
  });

  it('reports a request still in progress', async () => {
    await service.begin(request);

    await expect(service.begin(request)).rejects.toThrow(
      IdempotencyRequestInProgressException,
    );
  });

  it('lets exactly one of several concurrent requests execute', async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.begin(request)),
    );

    const executed = outcomes.filter(
      (o) => o.status === 'fulfilled' && o.value.kind === 'execute',
    );
    expect(executed).toHaveLength(1);
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );
    rejected.forEach((o) =>
      expect(o.reason).toBeInstanceOf(IdempotencyRequestInProgressException),
    );
  });

  it('frees the key after a failure so the client can retry', async () => {
    const first = await service.begin(request);
    if (first.kind !== 'execute') throw new Error('expected execute');

    await service.release(first.recordId);

    await expect(service.begin(request)).resolves.toMatchObject({
      kind: 'execute',
    });
  });

  it('lets a retry take over a stale in-progress key', async () => {
    await service.begin(request);
    await dataSource.query(
      `UPDATE idempotency_keys SET locked_at = now() - interval '5 minutes'`,
    );

    await expect(service.begin(request)).resolves.toMatchObject({
      kind: 'execute',
    });
  });

  it('treats expired keys as unused', async () => {
    const first = await service.begin(request);
    if (first.kind !== 'execute') throw new Error('expected execute');
    await service.complete(first.recordId, 201, { id: 'old' });
    await dataSource.query(
      `UPDATE idempotency_keys SET expires_at = now() - interval '1 second'`,
    );

    await expect(
      service.begin({ ...request, requestHash: 'b'.repeat(64) }),
    ).resolves.toMatchObject({
      kind: 'execute',
    });
    await expect(
      dataSource.getRepository(IdempotencyKey).count(),
    ).resolves.toBe(1);
  });

  it('scopes keys per user', async () => {
    await service.begin(request);
    const other = await moduleRef.get(UsersService).create({
      email: 'bob@example.com',
      passwordHash: 'x',
      firstName: 'B',
      lastName: 'B',
    });

    await expect(
      service.begin({ ...request, owner: userOwner(other.id) }),
    ).resolves.toMatchObject({
      kind: 'execute',
    });
  });

  it('deletes expired keys only', async () => {
    await service.begin(request);
    await service.begin({ ...request, key: 'key-2' });
    await dataSource.query(
      `UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = 'key-1'`,
    );

    await expect(service.deleteExpired()).resolves.toBe(1);
    await expect(
      dataSource.getRepository(IdempotencyKey).count(),
    ).resolves.toBe(1);
  });
});
