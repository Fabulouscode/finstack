import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { CreatedApiKeyResponseDto } from '../src/api-keys/dto/api-key.dto';
import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import { LedgerService } from '../src/ledger/ledger.service';
import {
  MOCK_INVALID_ACCOUNT_NUMBER,
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../src/payment-providers/mock/mock-payment.provider';
import { OrganizationResponseDto } from '../src/organizations/dto/organization.dto';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import {
  PayoutDestinationResponseDto,
  PayoutResponseDto,
} from '../src/payouts/dto/payout.dto';
import { PayoutsService } from '../src/payouts/payouts.service';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

describe('Payouts (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let mock: MockPaymentProvider;
  let user: AuthResponseDto;
  let keys = 0;

  const as = (
    token: string,
    method: 'get' | 'post' | 'delete',
    path: string,
  ): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const asUser = (
    method: 'get' | 'post' | 'delete',
    path: string,
  ): request.Test => as(user.tokens.accessToken, method, path);

  const deliver = async ({
    rawBody,
    signature,
  }: {
    rawBody: Buffer;
    signature: string;
  }): Promise<void> => {
    await request(app.getHttpServer())
      .post('/v1/webhooks/mock')
      .set('Content-Type', 'application/json')
      .set(MOCK_SIGNATURE_HEADER, signature)
      .send(rawBody.toString('utf8'))
      .expect(200);
  };

  const balances = async (
    path = '/v1/wallets/primary',
    token = user.tokens.accessToken,
  ): Promise<WalletResponseDto['balances']> =>
    ((await as(token, 'get', path).expect(200)).body as WalletResponseDto)
      .balances;

  /** Tops up through a real (mock) payment and waits for the credit. */
  const fund = async (
    amount: number,
    paymentsPath = '/v1/payments',
    walletPath = '/v1/wallets/primary',
    token = user.tokens.accessToken,
  ): Promise<void> => {
    const before = (await balances(walletPath, token)).available;
    const payment = expectStatus(
      await as(token, 'post', paymentsPath)
        .set('Idempotency-Key', `fund-${++keys}`)
        .send({
          amount,
          currency: 'USD',
          ...(paymentsPath === '/v1/payments'
            ? {}
            : { customerEmail: 'c@example.com' }),
        }),
      201,
      'fund',
    ).body as PaymentResponseDto;
    await deliver(
      mock.simulateOutcome(payment.providerReference ?? '', 'successful'),
    );
    await eventually(async () => {
      expect((await balances(walletPath, token)).available).toBe(
        before + amount,
      );
    });
  };

  const addDestination = async (
    path = '/v1/payout-destinations',
    token = user.tokens.accessToken,
  ): Promise<PayoutDestinationResponseDto> =>
    expectStatus(
      await as(token, 'post', path).send({
        currency: 'USD',
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'Ada Lovelace',
      }),
      201,
      'add destination',
    ).body as PayoutDestinationResponseDto;

  const payout = (
    body: object,
    key = `payout-${++keys}`,
    path = '/v1/payouts',
    send: (path: string) => request.Test = (p) => asUser('post', p),
  ): request.Test => send(path).set('Idempotency-Key', key).send(body);

  const getPayout = async (id: string): Promise<PayoutResponseDto> =>
    (await asUser('get', `/v1/payouts/${id}`).expect(200))
      .body as PayoutResponseDto;

  const settledAs = (id: string, status: string): Promise<PayoutResponseDto> =>
    eventually(async () => {
      const current = await getPayout(id);
      expect(current.status).toBe(status);
      return current;
    });

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    mock = app.get(MockPaymentProvider);
    mock.setPayoutBehaviour('successful');
    await resetDatabase(dataSource);

    user = await registerUser(app, 'ada@example.com');
    expectStatus(await asUser('post', '/v1/wallets').send({}), 201, 'wallet');
    await fund(10_000);
  });

  afterEach(async () => {
    const ledger = app.get(LedgerService);
    await expect(ledger.findBalanceDiscrepancies()).resolves.toEqual([]);
    const trial = await ledger.trialBalance('USD');
    expect(trial.debit).toBe(trial.credit);
    await app.close();
    process.env = originalEnv;
  });

  describe('destinations', () => {
    it('keeps only the last four digits of the account number', async () => {
      const destination = await addDestination();
      expect(destination).toMatchObject({
        currency: 'USD',
        accountName: 'Ada Lovelace',
        accountNumberLast4: '6789',
      });

      const [row] = await dataSource.query<object[]>(
        'SELECT * FROM payout_destinations',
      );
      expect(JSON.stringify(row)).not.toContain('0123456789');

      const again = await asUser('post', '/v1/payout-destinations').send({
        currency: 'USD',
        bankCode: '058',
        accountNumber: '0123456789',
      });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({
        code: 'PAYOUT_DESTINATION_ALREADY_EXISTS',
      });
    });

    it('rejects accounts the provider cannot verify', async () => {
      const response = await asUser('post', '/v1/payout-destinations').send({
        currency: 'USD',
        bankCode: '058',
        accountNumber: MOCK_INVALID_ACCOUNT_NUMBER,
      });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({
        code: 'PAYOUT_DESTINATION_REJECTED',
      });
    });

    it('can be removed, after which payouts to it are refused', async () => {
      const destination = await addDestination();
      await asUser(
        'delete',
        `/v1/payout-destinations/${destination.id}`,
      ).expect(204);
      await asUser('get', '/v1/payout-destinations').expect(200, []);

      const response = await payout({
        destinationId: destination.id,
        amount: 100,
      });
      expect(response.status).toBe(404);
    });
  });

  describe('payouts', () => {
    it('sends money out of the wallet', async () => {
      const destination = await addDestination();

      const created = expectStatus(
        await payout({ destinationId: destination.id, amount: 4_000 }),
        201,
        'payout',
      ).body as PayoutResponseDto;

      expect(created).toMatchObject({
        status: 'successful',
        amount: 4_000,
        currency: 'USD',
        destination: { accountNumberLast4: '6789' },
      });
      expect(created.reference).toMatch(/^pyt_[0-9a-f]{20}$/);
      expect(await balances()).toEqual({
        available: 6_000,
        pending: 0,
        reserved: 0,
      });
    });

    it('holds the funds while the provider is processing, then settles by webhook', async () => {
      const destination = await addDestination();
      mock.setPayoutBehaviour('pending');

      const created = expectStatus(
        await payout({ destinationId: destination.id, amount: 4_000 }),
        201,
        'payout',
      ).body as PayoutResponseDto;
      expect(created.status).toBe('processing');
      expect(await balances()).toMatchObject({
        available: 6_000,
        reserved: 4_000,
      });

      await deliver(
        mock.simulatePayoutOutcome(created.reference, 'successful'),
      );
      await settledAs(created.id, 'successful');
      expect(await balances()).toMatchObject({ available: 6_000, reserved: 0 });
    });

    it('releases the hold when the payout fails', async () => {
      const destination = await addDestination();
      mock.setPayoutBehaviour('pending');
      const created = (
        await payout({ destinationId: destination.id, amount: 4_000 })
      ).body as PayoutResponseDto;

      await deliver(mock.simulatePayoutOutcome(created.reference, 'failed'));
      const failed = await settledAs(created.id, 'failed');
      expect(failed.failureCode).toBe('PAYOUT_FAILED');
      expect(await balances()).toMatchObject({
        available: 10_000,
        reserved: 0,
      });
    });

    it('fails immediately when the provider rejects it', async () => {
      const destination = await addDestination();
      mock.setPayoutBehaviour('rejected');

      const created = expectStatus(
        await payout({ destinationId: destination.id, amount: 4_000 }),
        201,
        'payout',
      ).body as PayoutResponseDto;
      expect(created).toMatchObject({
        status: 'failed',
        failureCode: 'PROVIDER_REJECTED',
      });
      expect((await balances()).available).toBe(10_000);
    });

    it('credits the wallet back when the provider reverses a completed payout', async () => {
      const destination = await addDestination();
      const created = (
        await payout({ destinationId: destination.id, amount: 4_000 })
      ).body as PayoutResponseDto;
      expect(created.status).toBe('successful');

      await deliver(mock.simulatePayoutOutcome(created.reference, 'reversed'));
      await settledAs(created.id, 'reversed');
      expect((await balances()).available).toBe(10_000);
    });

    it('refuses to pay out more than the available balance', async () => {
      const destination = await addDestination();
      const response = await payout({
        destinationId: destination.id,
        amount: 10_001,
      });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      await expect(
        dataSource.query('SELECT 1 FROM payouts'),
      ).resolves.toHaveLength(0);
    });

    it('is idempotent and never sends twice', async () => {
      const destination = await addDestination();
      const body = { destinationId: destination.id, amount: 1_000 };

      const [a, b] = await Promise.all([
        payout(body, 'same-key'),
        payout(body, 'same-key'),
      ]);
      const ids = [a, b]
        .filter((response) => response.status === 201)
        .map((response) => (response.body as PayoutResponseDto).id);
      expect(new Set(ids).size).toBe(1);

      const retried = expectStatus(
        await payout(body, 'same-key'),
        201,
        'retry',
      );
      expect((retried.body as PayoutResponseDto).id).toBe(ids[0]);
      expect(mock.initiatedPayouts).toHaveLength(1);
      expect((await balances()).available).toBe(9_000);
    });

    it('recovers from a lost provider response without paying twice', async () => {
      const destination = await addDestination();
      mock.setPayoutBehaviour('lost');

      const created = expectStatus(
        await payout({ destinationId: destination.id, amount: 2_500 }),
        201,
        'payout',
      ).body as PayoutResponseDto;
      // The provider sent it, but we never heard back.
      expect(created.status).toBe('processing');

      mock.setPayoutBehaviour('successful');
      await app.get(PayoutsService).syncStale(0);

      await settledAs(created.id, 'successful');
      expect(mock.initiatedPayouts).toEqual([created.reference]);
      expect((await balances()).available).toBe(7_500);
    });

    it('lets admins re-check a payout with the provider', async () => {
      const destination = await addDestination();
      mock.setPayoutBehaviour('unavailable');
      const created = (
        await payout({ destinationId: destination.id, amount: 1_000 })
      ).body as PayoutResponseDto;
      expect(created.status).toBe('processing');

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

      // The provider never received it; the admin sync sends it once the
      // first attempt is old enough to be safely retried.
      await dataSource.query(
        `UPDATE payouts SET submitted_at = now() - interval '1 hour'`,
      );
      mock.setPayoutBehaviour('successful');
      const synced = expectStatus(
        await as(
          admin.tokens.accessToken,
          'post',
          `/v1/admin/payouts/${created.id}/sync`,
        ),
        200,
        'sync',
      ).body as PayoutResponseDto;
      expect(synced.status).toBe('successful');
      expect(mock.initiatedPayouts).toEqual([created.reference]);
    });

    it('hides other users’ payouts and destinations', async () => {
      const destination = await addDestination();
      const created = (
        await payout({ destinationId: destination.id, amount: 1_000 })
      ).body as PayoutResponseDto;

      const eve = await registerUser(app, 'eve@example.com');
      await as(
        eve.tokens.accessToken,
        'get',
        `/v1/payouts/${created.id}`,
      ).expect(404);
      await as(eve.tokens.accessToken, 'post', '/v1/wallets')
        .send({})
        .expect(201);
      const stolen = await as(eve.tokens.accessToken, 'post', '/v1/payouts')
        .set('Idempotency-Key', 'eve')
        .send({ destinationId: destination.id, amount: 1 });
      expect(stolen.status).toBe(404);
    });
  });

  describe('organizations', () => {
    let orgId: string;
    const orgPath = (suffix: string): string =>
      `/v1/organizations/${orgId}${suffix}`;

    beforeEach(async () => {
      orgId = (
        expectStatus(
          await asUser('post', '/v1/organizations').send({ name: 'Acme' }),
          201,
          'org',
        ).body as OrganizationResponseDto
      ).id;
      const wallet = expectStatus(
        await asUser('post', orgPath('/wallets')).send({}),
        201,
        'org wallet',
      ).body as WalletResponseDto;
      await fund(
        20_000,
        orgPath('/payments'),
        orgPath(`/wallets/${wallet.id}`),
      );
    });

    it('pays out from the organization wallet with a scoped API key', async () => {
      const destination = await addDestination(orgPath('/payout-destinations'));
      const { key } = expectStatus(
        await asUser('post', orgPath('/api-keys')).send({
          name: 'Payout server',
          scopes: ['payouts:create', 'transactions:read'],
        }),
        201,
        'key',
      ).body as CreatedApiKeyResponseDto;
      const withKey = (method: 'get' | 'post', path: string): request.Test =>
        request(app.getHttpServer())[method](path).set('X-API-Key', key);

      await withKey('get', orgPath('/payout-destinations')).expect(200);
      const created = expectStatus(
        await withKey('post', orgPath('/payouts'))
          .set('Idempotency-Key', 'org-payout')
          .send({ destinationId: destination.id, amount: 5_000 }),
        201,
        'org payout',
      ).body as PayoutResponseDto;
      expect(created.status).toBe('successful');
      await withKey('get', orgPath(`/payouts/${created.id}`)).expect(200);

      // Keys can't save bank accounts: that route doesn't accept them.
      const denied = await withKey(
        'post',
        orgPath('/payout-destinations'),
      ).send({ currency: 'USD', bankCode: '058', accountNumber: '9999999999' });
      expect(denied.status).toBe(401);
      expect(denied.body).toMatchObject({ code: 'API_KEY_NOT_ALLOWED' });

      // The member's personal wallet is untouched.
      expect((await balances()).available).toBe(10_000);
    });

    it('requires payout permissions', async () => {
      const member = await registerUser(app, 'bola@example.com');
      await asUser('post', orgPath('/members'))
        .send({ email: 'bola@example.com', role: 'member' })
        .expect(201);
      const destination = await addDestination(orgPath('/payout-destinations'));

      const addDenied = await as(
        member.tokens.accessToken,
        'post',
        orgPath('/payout-destinations'),
      ).send({ currency: 'USD', bankCode: '058', accountNumber: '1111111111' });
      expect(addDenied.status).toBe(403);

      const payDenied = await as(
        member.tokens.accessToken,
        'post',
        orgPath('/payouts'),
      )
        .set('Idempotency-Key', 'member')
        .send({ destinationId: destination.id, amount: 100 });
      expect(payDenied.status).toBe(403);
      expect(payDenied.body).toMatchObject({
        code: 'ORGANIZATION_PERMISSION_DENIED',
      });
    });
  });
});
