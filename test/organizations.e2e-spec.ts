import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import {
  MemberResponseDto,
  OrganizationResponseDto,
} from '../src/organizations/dto/organization.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';

describe('Organizations (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let orgId: string;

  const as = (
    who: string,
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
  ): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${tokens[who]}`);

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    await resetDatabase(dataSource);
    for (const who of ['owner', 'bola', 'chi', 'outsider']) {
      const session = await registerUser(app, `${who}@example.com`);
      tokens[who] = session.tokens.accessToken;
      ids[who] = session.user.id;
    }
    orgId = (
      expectStatus(
        await as('owner', 'post', '/v1/organizations').send({
          name: 'Acme Ltd',
        }),
        201,
        'create org',
      ).body as OrganizationResponseDto
    ).id;
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  const addMember = (
    email: string,
    role: string,
    who = 'owner',
  ): request.Test =>
    as(who, 'post', `/v1/organizations/${orgId}/members`).send({ email, role });

  it('makes the creator the owner, with every permission', async () => {
    const list = (await as('owner', 'get', '/v1/organizations').expect(200))
      .body as OrganizationResponseDto[];

    expect(list).toEqual([
      expect.objectContaining({
        id: orgId,
        name: 'Acme Ltd',
        role: 'owner',
        status: 'active',
      }),
    ]);
    expect(list[0]?.permissions).toContain('api_keys:manage');
  });

  it('hides organizations from non-members (404, not 403)', async () => {
    const response = await as(
      'outsider',
      'get',
      `/v1/organizations/${orgId}`,
    ).expect(404);
    expect(response.body).toMatchObject({ code: 'ORGANIZATION_NOT_FOUND' });
    // The access guard runs before param pipes: malformed ids are simply not found.
    await as('outsider', 'get', '/v1/organizations/not-a-uuid').expect(404);
  });

  it('lets members act only within their role', async () => {
    await addMember('bola@example.com', 'member').expect(201);
    await addMember('chi@example.com', 'viewer').expect(201);

    await as('bola', 'get', `/v1/organizations/${orgId}/members`).expect(200);
    const denied = await addMember(
      'outsider@example.com',
      'viewer',
      'bola',
    ).expect(403);
    expect(denied.body).toMatchObject({
      code: 'ORGANIZATION_PERMISSION_DENIED',
      detail:
        'This requires the "members:manage" permission in the organization',
    });
    await as('chi', 'patch', `/v1/organizations/${orgId}`)
      .send({ name: 'Nope' })
      .expect(403);
  });

  it('lets an admin manage members but not the organization itself', async () => {
    await addMember('bola@example.com', 'admin').expect(201);

    await addMember('chi@example.com', 'viewer', 'bola').expect(201);
    await as('bola', 'patch', `/v1/organizations/${orgId}/members/${ids.chi}`)
      .send({ role: 'member' })
      .expect(200);
    await as('bola', 'patch', `/v1/organizations/${orgId}`)
      .send({ name: 'Renamed' })
      .expect(403);
  });

  it('protects the owner and refuses granting ownership through roles', async () => {
    await addMember('bola@example.com', 'admin').expect(201);

    const demote = await as(
      'bola',
      'patch',
      `/v1/organizations/${orgId}/members/${ids.owner}`,
    )
      .send({ role: 'viewer' })
      .expect(422);
    expect(demote.body).toMatchObject({ code: 'OWNER_CHANGE_NOT_ALLOWED' });
    await as(
      'bola',
      'delete',
      `/v1/organizations/${orgId}/members/${ids.owner}`,
    ).expect(422);
    await addMember('chi@example.com', 'owner').expect(400);
  });

  it('transfers ownership; the previous owner becomes an admin', async () => {
    await addMember('bola@example.com', 'member').expect(201);

    await as('owner', 'post', `/v1/organizations/${orgId}/transfer-ownership`)
      .send({ userId: ids.bola })
      .expect(204);

    const members = (
      await as('bola', 'get', `/v1/organizations/${orgId}/members`).expect(200)
    ).body as MemberResponseDto[];
    expect(Object.fromEntries(members.map((m) => [m.email, m.role]))).toEqual({
      'owner@example.com': 'admin',
      'bola@example.com': 'owner',
    });
  });

  it('enforces a single owner in the database', async () => {
    await addMember('bola@example.com', 'member').expect(201);

    await expect(
      dataSource.query(
        `UPDATE organization_members SET role = 'owner' WHERE organization_id = $1 AND user_id = $2`,
        [orgId, ids.bola],
      ),
    ).rejects.toThrow(/uq_organization_members_owner/);
  });

  it('rejects duplicate members and unknown users', async () => {
    await addMember('bola@example.com', 'member').expect(201);

    const duplicate = await addMember('bola@example.com', 'viewer').expect(409);
    expect(duplicate.body).toMatchObject({ code: 'MEMBER_ALREADY_EXISTS' });
    const unknown = await addMember('nobody@example.com', 'viewer').expect(422);
    expect(unknown.body).toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('blocks everything but reading while the organization is suspended', async () => {
    await dataSource.query(`UPDATE organizations SET status = 'suspended'`);

    await as('owner', 'get', `/v1/organizations/${orgId}`).expect(200);
    const blocked = await addMember('bola@example.com', 'member').expect(403);
    expect(blocked.body).toMatchObject({ code: 'ORGANIZATION_SUSPENDED' });
  });

  it('removes members, who then lose access', async () => {
    await addMember('bola@example.com', 'member').expect(201);

    await as(
      'owner',
      'delete',
      `/v1/organizations/${orgId}/members/${ids.bola}`,
    ).expect(204);

    await as('bola', 'get', `/v1/organizations/${orgId}`).expect(404);
  });
});
