import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import {
  ApiKeyResponseDto,
  CreatedApiKeyResponseDto,
} from '../src/api-keys/dto/api-key.dto';
import { OrganizationResponseDto } from '../src/organizations/dto/organization.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';

describe('API keys (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let ownerToken: string;
  let orgId: string;
  let otherOrgId: string;

  const asUser = (
    token: string,
    method: 'get' | 'post' | 'delete',
    path: string,
  ): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const withKey = (
    key: string,
    method: 'get' | 'post',
    path: string,
  ): request.Test =>
    request(app.getHttpServer())[method](path).set('X-API-Key', key);

  const createKey = async (
    scopes: string[],
    extra: object = {},
  ): Promise<CreatedApiKeyResponseDto> =>
    expectStatus(
      await asUser(
        ownerToken,
        'post',
        `/v1/organizations/${orgId}/api-keys`,
      ).send({
        name: 'Checkout server',
        scopes,
        ...extra,
      }),
      201,
      'create key',
    ).body as CreatedApiKeyResponseDto;

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    await resetDatabase(dataSource);
    ownerToken = (await registerUser(app, 'owner@example.com')).tokens
      .accessToken;
    orgId = (
      expectStatus(
        await asUser(ownerToken, 'post', '/v1/organizations').send({
          name: 'Acme',
        }),
        201,
        'org',
      ).body as OrganizationResponseDto
    ).id;
    otherOrgId = (
      expectStatus(
        await asUser(ownerToken, 'post', '/v1/organizations').send({
          name: 'Other',
        }),
        201,
        'org2',
      ).body as OrganizationResponseDto
    ).id;
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  it('shows the secret once and stores only a hash', async () => {
    const created = await createKey(['organization:read']);

    expect(created.key).toMatch(/^fsk_test_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(created.key.startsWith(created.prefix)).toBe(true);
    const listed = (
      await asUser(
        ownerToken,
        'get',
        `/v1/organizations/${orgId}/api-keys`,
      ).expect(200)
    ).body as ApiKeyResponseDto[];
    expect(listed[0]).not.toHaveProperty('key');
    const [row] = await dataSource.query<{ key_hash: string }[]>(
      'SELECT key_hash FROM api_keys',
    );
    expect(row?.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.key_hash).not.toContain(created.key.split('_')[3]);
  });

  it('authenticates on allowed routes, within its organization and scopes', async () => {
    const { key } = await createKey(['organization:read']);

    const response = await withKey(
      key,
      'get',
      `/v1/organizations/${orgId}`,
    ).expect(200);
    expect(response.body).toMatchObject({
      id: orgId,
      role: null,
      permissions: ['organization:read'],
    });

    await withKey(key, 'get', `/v1/organizations/${otherOrgId}`).expect(404);
  });

  it('enforces scopes', async () => {
    const { key } = await createKey(['transactions:read']);

    const response = await withKey(
      key,
      'get',
      `/v1/organizations/${orgId}`,
    ).expect(403);
    expect(response.body).toMatchObject({ code: 'API_KEY_SCOPE_MISSING' });
  });

  it('is rejected on routes that do not allow API keys (secure by default)', async () => {
    const { key } = await createKey(['organization:read', 'wallets:read']);

    for (const path of [
      '/v1/wallets/primary',
      '/v1/organizations',
      `/v1/organizations/${orgId}/api-keys`,
    ]) {
      const response = await withKey(key, 'get', path).expect(401);
      expect(response.body).toMatchObject({ code: 'API_KEY_NOT_ALLOWED' });
    }
  });

  it('cannot carry management scopes', async () => {
    const response = await asUser(
      ownerToken,
      'post',
      `/v1/organizations/${orgId}/api-keys`,
    )
      .send({ name: 'Too powerful', scopes: ['api_keys:manage'] })
      .expect(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('stops working when revoked, expired, malformed or the organization is suspended', async () => {
    const revoked = await createKey(['organization:read']);
    await asUser(
      ownerToken,
      'delete',
      `/v1/organizations/${orgId}/api-keys/${revoked.id}`,
    ).expect(204);
    const expired = await createKey(['organization:read'], {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await dataSource.query(
      `UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [expired.id],
    );
    const active = await createKey(['organization:read']);

    for (const key of [
      revoked.key,
      expired.key,
      'fsk_test_nothex_x',
      'not-a-key',
    ]) {
      const response = await withKey(
        key,
        'get',
        `/v1/organizations/${orgId}`,
      ).expect(401);
      expect(response.body).toMatchObject({ code: 'INVALID_API_KEY' });
    }

    await withKey(active.key, 'get', `/v1/organizations/${orgId}`).expect(200);
    await dataSource.query(
      `UPDATE organizations SET status = 'suspended' WHERE id = $1`,
      [orgId],
    );
    await withKey(active.key, 'get', `/v1/organizations/${orgId}`).expect(401);
  });

  it('records when a key was last used', async () => {
    const created = await createKey(['organization:read']);
    expect(created.lastUsedAt).toBeNull();

    await withKey(created.key, 'get', `/v1/organizations/${orgId}`).expect(200);

    const [listed] = (
      await asUser(
        ownerToken,
        'get',
        `/v1/organizations/${orgId}/api-keys`,
      ).expect(200)
    ).body as ApiKeyResponseDto[];
    expect(listed?.lastUsedAt).not.toBeNull();
  });

  it('only lets members with api_keys:manage create keys', async () => {
    const memberToken = (await registerUser(app, 'member@example.com')).tokens
      .accessToken;
    await asUser(ownerToken, 'post', `/v1/organizations/${orgId}/members`)
      .send({ email: 'member@example.com', role: 'member' })
      .expect(201);

    const response = await asUser(
      memberToken,
      'post',
      `/v1/organizations/${orgId}/api-keys`,
    )
      .send({ name: 'x', scopes: ['organization:read'] })
      .expect(403);
    expect(response.body).toMatchObject({
      code: 'ORGANIZATION_PERMISSION_DENIED',
    });
  });
});
