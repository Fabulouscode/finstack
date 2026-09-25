import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { CreatedApiKeyResponseDto } from '../src/api-keys/dto/api-key.dto';
import { AuditLogsPageDto } from '../src/audit/dto/audit-log.dto';
import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import { OrganizationResponseDto } from '../src/organizations/dto/organization.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';

describe('Audit logs (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let owner: AuthResponseDto;
  let orgId: string;

  const as = (
    token: string,
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
  ): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const orgLog = async (query = ''): Promise<AuditLogsPageDto> =>
    expectStatus(
      await as(
        owner.tokens.accessToken,
        'get',
        `/v1/organizations/${orgId}/audit-logs${query}`,
      ),
      200,
      'org audit log',
    ).body as AuditLogsPageDto;

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    await resetDatabase(dataSource);
    owner = await registerUser(app, 'owner@example.com');
    orgId = (
      expectStatus(
        await as(owner.tokens.accessToken, 'post', '/v1/organizations').send({
          name: 'Acme',
        }),
        201,
        'org',
      ).body as OrganizationResponseDto
    ).id;
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  it("records who changed an organization's members, keys and wallets", async () => {
    const bola = await registerUser(app, 'bola@example.com');
    const token = owner.tokens.accessToken;
    await as(token, 'post', `/v1/organizations/${orgId}/members`)
      .send({ email: 'bola@example.com', role: 'member' })
      .expect(201);
    await as(
      token,
      'patch',
      `/v1/organizations/${orgId}/members/${bola.user.id}`,
    )
      .set('X-Request-Id', 'promote-bola')
      .send({ role: 'admin' })
      .expect(200);
    const { id: keyId, key } = expectStatus(
      await as(token, 'post', `/v1/organizations/${orgId}/api-keys`).send({
        name: 'Server',
        scopes: ['wallets:manage'],
      }),
      201,
      'key',
    ).body as CreatedApiKeyResponseDto;
    await request(app.getHttpServer())
      .post(`/v1/organizations/${orgId}/wallets`)
      .set('X-API-Key', key)
      .send({})
      .expect(201);

    const { data } = await orgLog();
    expect(data.map((log) => log.action)).toEqual([
      'wallet.created',
      'api_key.created',
      'member.role_changed',
      'member.added',
      'organization.created',
    ]);
    expect(data[0]?.actor).toEqual({ type: 'api_key', id: keyId });
    expect(data[2]).toMatchObject({
      actor: { type: 'user', id: owner.user.id },
      targetId: bola.user.id,
      metadata: { from: 'member', to: 'admin' },
      requestId: 'promote-bola',
    });
    // The secret never reaches the log.
    expect(JSON.stringify(data)).not.toContain(key);

    const filtered = await orgLog('?action=member.added');
    expect(filtered.data).toHaveLength(1);
  });

  it('is visible to owners and admins only', async () => {
    const viewer = await registerUser(app, 'viewer@example.com');
    await as(
      owner.tokens.accessToken,
      'post',
      `/v1/organizations/${orgId}/members`,
    )
      .send({ email: 'viewer@example.com', role: 'viewer' })
      .expect(201);

    const denied = await as(
      viewer.tokens.accessToken,
      'get',
      `/v1/organizations/${orgId}/audit-logs`,
    );
    expect(denied.status).toBe(403);
  });

  it('lets platform admins search everything, including security events', async () => {
    // Replaying a rotated refresh token revokes the session and is audited.
    const rotated = expectStatus(
      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken: owner.tokens.refreshToken }),
      200,
      'refresh',
    );
    expect(rotated.body).toBeDefined();
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: owner.tokens.refreshToken })
      .expect(401);

    await registerUser(app, 'admin@example.com');
    await dataSource.query(
      `UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'`,
    );
    const admin = expectStatus(
      await request(app.getHttpServer()).post('/v1/auth/login').send({
        email: 'admin@example.com',
        password: 'correct-horse-battery-staple',
      }),
      200,
      'admin login',
    ).body as AuthResponseDto;

    const page = expectStatus(
      await as(
        admin.tokens.accessToken,
        'get',
        '/v1/admin/audit-logs?action=auth.refresh_token_reuse_detected',
      ),
      200,
      'admin search',
    ).body as AuditLogsPageDto;
    expect(page.data).toEqual([
      expect.objectContaining({
        actor: { type: 'system', id: null },
        targetType: 'user',
        targetId: owner.user.id,
      }),
    ]);

    // Members can't use the admin endpoint.
    await as(owner.tokens.accessToken, 'get', '/v1/admin/audit-logs').expect(
      403,
    );
  });
});
