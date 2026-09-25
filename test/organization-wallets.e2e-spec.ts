import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { CreatedApiKeyResponseDto } from '../src/api-keys/dto/api-key.dto';
import { AdminRateProvider } from '../src/fx/admin-rate.provider';
import { LedgerService } from '../src/ledger/ledger.service';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../src/payment-providers/mock/mock-payment.provider';
import { OrganizationResponseDto } from '../src/organizations/dto/organization.dto';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import { TransactionsPageDto } from '../src/transactions/dto/transaction.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

describe('Organization wallets and payments (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let mock: MockPaymentProvider;
  let ownerToken: string;
  let orgId: string;
  let keys = 0;

  const as = (
    token: string,
    method: 'get' | 'post',
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

  const orgPath = (suffix = '', id = orgId): string =>
    `/v1/organizations/${id}${suffix}`;

  const createOrg = async (token: string, name: string): Promise<string> =>
    (
      expectStatus(
        await as(token, 'post', '/v1/organizations').send({ name }),
        201,
        'create org',
      ).body as OrganizationResponseDto
    ).id;

  const createKey = async (scopes: string[]): Promise<string> =>
    (
      expectStatus(
        await as(ownerToken, 'post', orgPath('/api-keys')).send({
          name: 'Checkout server',
          scopes,
        }),
        201,
        'create key',
      ).body as CreatedApiKeyResponseDto
    ).key;

  const addMember = async (email: string, role: string): Promise<string> => {
    const { tokens } = await registerUser(app, email);
    expectStatus(
      await as(ownerToken, 'post', orgPath('/members')).send({ email, role }),
      201,
      'add member',
    );
    return tokens.accessToken;
  };

  const orgWallet = async (): Promise<WalletResponseDto> =>
    (
      (await as(ownerToken, 'get', orgPath('/wallets')).expect(200))
        .body as WalletResponseDto[]
    )[0] as WalletResponseDto;

  const payProvider = async (payment: PaymentResponseDto): Promise<void> => {
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
  };

  const collect = (
    send: (path: string) => request.Test,
    body: object,
    key = `org-pay-${++keys}`,
  ): request.Test =>
    send(orgPath('/payments'))
      .set('Idempotency-Key', key)
      .send({ customerEmail: 'customer@example.com', ...body });

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    mock = app.get(MockPaymentProvider);
    await resetDatabase(dataSource);
    await app
      .get(AdminRateProvider)
      .setRate({ base: 'USD', quote: 'NGN', rate: '1550', userId: null });

    ownerToken = (await registerUser(app, 'owner@example.com')).tokens
      .accessToken;
    orgId = await createOrg(ownerToken, 'Acme');
    expectStatus(
      await as(ownerToken, 'post', orgPath('/wallets')).send({}),
      201,
      'open org wallet',
    );
  });

  afterEach(async () => {
    const ledger = app.get(LedgerService);
    await expect(ledger.findBalanceDiscrepancies()).resolves.toEqual([]);
    for (const currency of ['USD', 'NGN']) {
      const trial = await ledger.trialBalance(currency);
      expect(trial.debit).toBe(trial.credit);
    }
    await app.close();
    process.env = originalEnv;
  });

  describe('wallets', () => {
    it('are owned by the organization, separately from its members', async () => {
      const wallet = await orgWallet();
      expect(wallet).toMatchObject({ currency: 'USD', isPrimary: true });

      // The owner's personal wallets are a different space.
      await as(ownerToken, 'get', '/v1/wallets').expect(200, []);
      await as(ownerToken, 'get', `/v1/wallets/${wallet.id}`).expect(404);
      expectStatus(
        await as(ownerToken, 'post', '/v1/wallets').send({}),
        201,
        'personal wallet',
      );

      // Same rules as user wallets: single mode means one wallet.
      const again = await as(ownerToken, 'post', orgPath('/wallets')).send({});
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
    });

    it('follow membership roles and hide from non-members', async () => {
      const viewer = await addMember('viewer@example.com', 'viewer');
      const wallet = await orgWallet();

      await as(viewer, 'get', orgPath(`/wallets/${wallet.id}`)).expect(200);
      const denied = await as(
        viewer,
        'post',
        orgPath(`/wallets/${wallet.id}/primary`),
      );
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({
        code: 'ORGANIZATION_PERMISSION_DENIED',
      });

      const outsider = (await registerUser(app, 'eve@example.com')).tokens
        .accessToken;
      const hidden = await as(outsider, 'get', orgPath('/wallets'));
      expect(hidden.status).toBe(404);
      expect(hidden.body).toMatchObject({ code: 'ORGANIZATION_NOT_FOUND' });

      // A wallet of another organization is not found through this one.
      const otherOrg = await createOrg(ownerToken, 'Other');
      await as(
        ownerToken,
        'get',
        orgPath(`/wallets/${wallet.id}`, otherOrg),
      ).expect(404);
    });

    it('are reachable with a scoped API key', async () => {
      const readKey = await createKey(['wallets:read']);
      await withKey(readKey, 'get', orgPath('/wallets')).expect(200);

      const denied = await withKey(readKey, 'post', orgPath('/wallets')).send(
        {},
      );
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'API_KEY_SCOPE_MISSING' });

      // A key only works for its own organization.
      const otherOrg = await createOrg(ownerToken, 'Other');
      await withKey(readKey, 'get', orgPath('/wallets', otherOrg)).expect(404);
    });
  });

  describe('payments', () => {
    it('collects from a customer into the organization wallet', async () => {
      const key = await createKey(['payments:create', 'transactions:read']);

      const payment = expectStatus(
        await collect((path) => withKey(key, 'post', path), {
          amount: 2500,
          currency: 'USD',
        }),
        201,
        'collect',
      ).body as PaymentResponseDto;
      expect(payment).toMatchObject({ status: 'pending', conversion: null });
      expect(payment.walletId).toBe((await orgWallet()).id);

      await payProvider(payment);
      await eventually(async () => {
        expect((await orgWallet()).balances.available).toBe(2500);
      });

      const page = (
        await withKey(key, 'get', orgPath('/transactions')).expect(200)
      ).body as TransactionsPageDto;
      expect(page.data).toEqual([
        expect.objectContaining({
          type: 'payment',
          status: 'successful',
          direction: 'incoming',
          amount: 2500,
        }),
      ]);
      await withKey(
        key,
        'get',
        orgPath(`/transactions/${page.data[0]?.id}`),
      ).expect(200);

      // The customer's email went to the provider; no member was charged.
      const [row] = await dataSource.query<
        { customer_email: string; user_id: string | null }[]
      >('SELECT customer_email, user_id FROM payments');
      expect(row).toEqual({
        customer_email: 'customer@example.com',
        user_id: null,
      });
    });

    it('converts foreign currencies into the primary wallet', async () => {
      const payment = expectStatus(
        await collect((path) => as(ownerToken, 'post', path), {
          amount: 1_550_000,
          currency: 'NGN',
        }),
        201,
        'collect NGN',
      ).body as PaymentResponseDto;
      expect(payment.conversion).toMatchObject({ currency: 'USD' });

      await payProvider(payment);
      await eventually(async () => {
        expect((await orgWallet()).balances.available).toBe(
          payment.conversion?.amount,
        );
      });
    });

    it('requires the customer email', async () => {
      const response = await as(ownerToken, 'post', orgPath('/payments'))
        .set('Idempotency-Key', 'no-email')
        .send({ amount: 100, currency: 'USD' });
      expect(response.status).toBe(400);
    });

    it('shares one idempotency key space across members and API keys', async () => {
      const key = await createKey(['payments:create']);
      const body = { amount: 700, currency: 'USD' };

      const first = expectStatus(
        await collect((path) => as(ownerToken, 'post', path), body, 'same'),
        201,
        'first',
      );
      const retried = expectStatus(
        await collect((path) => withKey(key, 'post', path), body, 'same'),
        201,
        'retry',
      );
      expect(retried.headers['idempotent-replayed']).toBe('true');
      expect((retried.body as PaymentResponseDto).id).toBe(
        (first.body as PaymentResponseDto).id,
      );

      // The owner's personal key space is separate.
      expectStatus(
        await as(ownerToken, 'post', '/v1/wallets').send({}),
        201,
        'personal wallet',
      );
      const personal = expectStatus(
        await as(ownerToken, 'post', '/v1/payments')
          .set('Idempotency-Key', 'same')
          .send(body),
        201,
        'personal payment',
      );
      expect(personal.headers['idempotent-replayed']).toBeUndefined();
      expect((personal.body as PaymentResponseDto).id).not.toBe(
        (first.body as PaymentResponseDto).id,
      );
    });

    it('needs payments:create and hides other organizations’ payments', async () => {
      const viewer = await addMember('viewer@example.com', 'viewer');
      const denied = await collect((path) => as(viewer, 'post', path), {
        amount: 100,
        currency: 'USD',
      });
      expect(denied.status).toBe(403);

      const payment = expectStatus(
        await collect((path) => as(ownerToken, 'post', path), {
          amount: 100,
          currency: 'USD',
        }),
        201,
        'collect',
      ).body as PaymentResponseDto;
      await as(viewer, 'get', orgPath(`/payments/${payment.id}`)).expect(200);

      const otherOrg = await createOrg(ownerToken, 'Other');
      await as(
        ownerToken,
        'get',
        orgPath(`/payments/${payment.id}`, otherOrg),
      ).expect(404);
      await as(ownerToken, 'get', `/v1/payments/${payment.id}`).expect(404);
    });
  });
});
