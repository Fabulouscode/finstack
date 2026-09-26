import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AdminOverviewResponseDto } from '../src/admin/dto/admin.dto';
import { CreatedApiKeyResponseDto } from '../src/api-keys/dto/api-key.dto';
import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import { OrganizationResponseDto } from '../src/organizations/dto/organization.dto';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../src/payment-providers/mock/mock-payment.provider';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import { UserResponseDto } from '../src/users/dto/user-response.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

describe('Admin tooling (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let mock: MockPaymentProvider;
  let admin: AuthResponseDto;
  let ada: AuthResponseDto;
  let keys = 0;

  const as = (
    token: string,
    method: 'get' | 'post',
    path: string,
  ): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const asAdmin = (method: 'get' | 'post', path: string): request.Test =>
    as(admin.tokens.accessToken, method, path);

  const reason = { reason: 'Compliance review #42' };

  const auditActions = async (targetId: string): Promise<unknown[]> =>
    dataSource.query(
      `SELECT action, metadata->>'reason' AS reason FROM audit_logs
        WHERE target_id = $1 ORDER BY created_at`,
      [targetId],
    );

  const fund = async (token: string, amount: number): Promise<void> => {
    const payment = expectStatus(
      await as(token, 'post', '/v1/payments')
        .set('Idempotency-Key', `pay-${++keys}`)
        .send({ amount, currency: 'USD' }),
      201,
      'payment',
    ).body as PaymentResponseDto;
    const { rawBody, signature } = mock.simulateOutcome(
      payment.providerReference ?? '',
      'successful',
    );
    await request(app.getHttpServer())
      .post('/v1/webhooks/mock')
      .set('Content-Type', 'application/json')
      .set(MOCK_SIGNATURE_HEADER, signature)
      .send(rawBody.toString('utf8'))
      .expect(200);
    await eventually(async () => {
      const wallet = (await as(token, 'get', '/v1/wallets/primary').expect(200))
        .body as WalletResponseDto;
      expect(wallet.balances.available).toBeGreaterThanOrEqual(amount);
    });
  };

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '100' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    mock = app.get(MockPaymentProvider);
    mock.setPayoutBehaviour('pending');
    await resetDatabase(dataSource);

    await registerUser(app, 'admin@example.com');
    await dataSource.query(
      `UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'`,
    );
    admin = expectStatus(
      await request(app.getHttpServer()).post('/v1/auth/login').send({
        email: 'admin@example.com',
        password: 'correct-horse-battery-staple',
      }),
      200,
      'admin login',
    ).body as AuthResponseDto;
    ada = await registerUser(app, 'ada@example.com');
    expectStatus(
      await as(ada.tokens.accessToken, 'post', '/v1/wallets').send({}),
      201,
      'wallet',
    );
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  describe('users', () => {
    it('suspends at once, even for tokens already issued, and reactivates', async () => {
      await as(ada.tokens.accessToken, 'get', '/v1/wallets').expect(200);

      const suspended = expectStatus(
        await asAdmin('post', `/v1/admin/users/${ada.user.id}/suspend`).send(
          reason,
        ),
        200,
        'suspend',
      ).body as UserResponseDto;
      expect(suspended.status).toBe('suspended');

      const refused = await as(ada.tokens.accessToken, 'get', '/v1/wallets');
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken: ada.tokens.refreshToken })
        .expect(401);

      await asAdmin('post', `/v1/admin/users/${ada.user.id}/reactivate`)
        .send({ reason: 'Cleared' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({
          email: 'ada@example.com',
          password: 'correct-horse-battery-staple',
        })
        .expect(200);

      await expect(auditActions(ada.user.id)).resolves.toEqual([
        { action: 'user.suspended', reason: 'Compliance review #42' },
        { action: 'user.reactivated', reason: 'Cleared' },
      ]);
    });

    it('refuses self-suspension and no-op changes', async () => {
      const self = await asAdmin(
        'post',
        `/v1/admin/users/${admin.user.id}/suspend`,
      ).send(reason);
      expect(self.status).toBe(422);
      expect(self.body).toMatchObject({ code: 'CANNOT_SUSPEND_SELF' });

      const noop = await asAdmin(
        'post',
        `/v1/admin/users/${ada.user.id}/reactivate`,
      ).send(reason);
      expect(noop.status).toBe(409);

      await asAdmin('post', `/v1/admin/users/${ada.user.id}/suspend`)
        .send({})
        .expect(400);
    });

    it('applies role changes immediately', async () => {
      await asAdmin('get', '/v1/admin/overview').expect(200);
      await dataSource.query(`UPDATE users SET role = 'user' WHERE id = $1`, [
        admin.user.id,
      ]);
      await asAdmin('get', '/v1/admin/overview').expect(403);
    });

    it('searches by email, pages, and escapes wildcards', async () => {
      for (const name of ['bob', 'bola', 'carol']) {
        await registerUser(app, `${name}@example.com`);
      }
      const bo = (await asAdmin('get', '/v1/admin/users?email=BO').expect(200))
        .body as Page<UserResponseDto>;
      expect(bo.data.map((u) => u.email).sort()).toEqual([
        'bob@example.com',
        'bola@example.com',
      ]);

      const first = (
        await asAdmin('get', '/v1/admin/users?limit=2').expect(200)
      ).body as Page<UserResponseDto>;
      expect(first.data).toHaveLength(2);
      const second = (
        await asAdmin(
          'get',
          `/v1/admin/users?limit=10&cursor=${first.nextCursor}`,
        ).expect(200)
      ).body as Page<UserResponseDto>;
      expect(second.data).toHaveLength(3); // 5 users in total
      expect(second.nextCursor).toBeNull();

      const wildcard = (
        await asAdmin('get', '/v1/admin/users?email=%25').expect(200)
      ).body as Page<UserResponseDto>;
      expect(wildcard.data).toEqual([]);
    });

    it('shows a user with their wallets and organizations', async () => {
      await as(ada.tokens.accessToken, 'post', '/v1/organizations')
        .send({ name: 'Ada Labs' })
        .expect(201);
      const detail = (
        await asAdmin('get', `/v1/admin/users/${ada.user.id}`).expect(200)
      ).body as {
        user: UserResponseDto;
        wallets: WalletResponseDto[];
        organizations: OrganizationResponseDto[];
      };
      expect(detail.user.email).toBe('ada@example.com');
      expect(detail.wallets).toHaveLength(1);
      expect(detail.organizations.map((o) => o.name)).toEqual(['Ada Labs']);
    });
  });

  describe('organizations', () => {
    it('suspends to read-only and stops API keys; reactivates', async () => {
      const orgId = (
        expectStatus(
          await as(ada.tokens.accessToken, 'post', '/v1/organizations').send({
            name: 'Acme',
          }),
          201,
          'org',
        ).body as OrganizationResponseDto
      ).id;
      const { key } = expectStatus(
        await as(
          ada.tokens.accessToken,
          'post',
          `/v1/organizations/${orgId}/api-keys`,
        ).send({ name: 'Server', scopes: ['organization:read'] }),
        201,
        'key',
      ).body as CreatedApiKeyResponseDto;

      await asAdmin('post', `/v1/admin/organizations/${orgId}/suspend`)
        .send(reason)
        .expect(200);

      await as(
        ada.tokens.accessToken,
        'get',
        `/v1/organizations/${orgId}`,
      ).expect(200);
      const write = await as(
        ada.tokens.accessToken,
        'post',
        `/v1/organizations/${orgId}/wallets`,
      ).send({});
      expect(write.body).toMatchObject({ code: 'ORGANIZATION_SUSPENDED' });
      await request(app.getHttpServer())
        .get(`/v1/organizations/${orgId}`)
        .set('X-API-Key', key)
        .expect(401);

      await asAdmin('post', `/v1/admin/organizations/${orgId}/reactivate`)
        .send(reason)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/organizations/${orgId}`)
        .set('X-API-Key', key)
        .expect(200);

      const found = (
        await asAdmin('get', '/v1/admin/organizations?name=acm').expect(200)
      ).body as Page<{ id: string }>;
      expect(found.data.map((o) => o.id)).toEqual([orgId]);
      const detail = (
        await asAdmin('get', `/v1/admin/organizations/${orgId}`).expect(200)
      ).body as { members: { email: string; role: string }[] };
      expect(detail.members).toEqual([
        expect.objectContaining({ email: 'ada@example.com', role: 'owner' }),
      ]);
    });
  });

  describe('wallets', () => {
    it('freezes a wallet so no money leaves it', async () => {
      await fund(ada.tokens.accessToken, 5_000);
      await registerUser(app, 'bob@example.com').then(async (bob) =>
        as(bob.tokens.accessToken, 'post', '/v1/wallets').send({}).expect(201),
      );
      const wallet = (
        await as(ada.tokens.accessToken, 'get', '/v1/wallets/primary').expect(
          200,
        )
      ).body as WalletResponseDto;

      const frozen = expectStatus(
        await asAdmin('post', `/v1/admin/wallets/${wallet.id}/freeze`).send(
          reason,
        ),
        200,
        'freeze',
      ).body as WalletResponseDto & { userId: string };
      expect(frozen).toMatchObject({ status: 'frozen', userId: ada.user.id });

      const transfer = await as(ada.tokens.accessToken, 'post', '/v1/transfers')
        .set('Idempotency-Key', 'while-frozen')
        .send({ recipientEmail: 'bob@example.com', amount: 1_000 });
      expect(transfer.body).toMatchObject({ code: 'WALLET_NOT_ACTIVE' });

      await asAdmin('post', `/v1/admin/wallets/${wallet.id}/unfreeze`)
        .send(reason)
        .expect(200);
      await as(ada.tokens.accessToken, 'post', '/v1/transfers')
        .set('Idempotency-Key', 'after-unfreeze')
        .send({ recipientEmail: 'bob@example.com', amount: 1_000 })
        .expect(201);

      await expect(auditActions(wallet.id)).resolves.toEqual([
        expect.objectContaining({ action: 'wallet.created' }),
        { action: 'wallet.frozen', reason: 'Compliance review #42' },
        { action: 'wallet.unfrozen', reason: 'Compliance review #42' },
      ]);
    });
  });

  it('summarises the platform and what needs attention', async () => {
    await fund(ada.tokens.accessToken, 5_000);
    const destination = (
      await as(ada.tokens.accessToken, 'post', '/v1/payout-destinations')
        .send({ currency: 'USD', bankCode: '058', accountNumber: '0123456789' })
        .expect(201)
    ).body as { id: string };
    await as(ada.tokens.accessToken, 'post', '/v1/payouts')
      .set('Idempotency-Key', 'pending-payout')
      .send({ destinationId: destination.id, amount: 1_500 })
      .expect(201);

    const overview = (await asAdmin('get', '/v1/admin/overview').expect(200))
      .body as AdminOverviewResponseDto;

    expect(overview).toMatchObject({
      users: { active: 2 },
      walletBalances: {
        USD: { available: 3_500, pending: 0, reserved: 1_500 },
      },
      attention: {
        processingPayouts: { count: 1 },
        processingRefunds: { count: 0 },
        openReconciliationItems: 0,
      },
    });

    await as(ada.tokens.accessToken, 'get', '/v1/admin/overview').expect(403);
  });
});
