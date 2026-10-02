import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { CreatedApiKeyResponseDto } from '../src/api-keys/dto/api-key.dto';
import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import { LedgerService } from '../src/ledger/ledger.service';
import { MockPaymentProvider } from '../src/payment-providers/mock/mock-payment.provider';
import { OrganizationResponseDto } from '../src/organizations/dto/organization.dto';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import {
  PayoutDestinationResponseDto,
  PayoutResponseDto,
} from '../src/payouts/dto/payout.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

describe('Sandbox (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
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
  const asAda = (method: 'get' | 'post', path: string): request.Test =>
    as(ada.tokens.accessToken, method, path);

  const available = async (): Promise<number> =>
    (
      (await asAda('get', '/v1/wallets/primary').expect(200))
        .body as WalletResponseDto
    ).balances.available;

  const boot = async (env: Record<string, string> = {}): Promise<void> => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '100', ...env };
    app = undefined as unknown as INestApplication<App>;
    app = await createTestApp();
    dataSource = app.get(DataSource);
    await resetDatabase(dataSource);
    ada = await registerUser(app, 'ada@example.com');
    await asAda('post', '/v1/wallets').send({}).expect(201);
  };

  afterEach(async () => {
    if (!app) return;
    const ledger = app.get(LedgerService);
    await expect(ledger.findBalanceDiscrepancies()).resolves.toEqual([]);
    await app.close();
    process.env = originalEnv;
  });

  describe('in a sandbox deployment', () => {
    beforeEach(() =>
      boot({
        NODE_ENV: 'production',
        SANDBOX_MODE: 'true',
        // A sandbox is a real deployment: production requirements still apply.
        JWT_ACCESS_SECRET: 'x'.repeat(40),
        DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      }),
    );

    it('labels responses and issues test keys, even with NODE_ENV=production', async () => {
      const response = await asAda('get', '/v1/wallets').expect(200);
      expect(response.headers['finstack-mode']).toBe('sandbox');

      const orgId = (
        (
          await asAda('post', '/v1/organizations')
            .send({ name: 'Acme' })
            .expect(201)
        ).body as OrganizationResponseDto
      ).id;
      const { key } = (
        await asAda('post', `/v1/organizations/${orgId}/api-keys`)
          .send({ name: 'Server', scopes: ['organization:read'] })
          .expect(201)
      ).body as CreatedApiKeyResponseDto;
      expect(key).toMatch(/^fsk_test_/);
    });

    it('funds a wallet with test money through the real pipeline', async () => {
      const funded = expectStatus(
        await asAda('post', '/v1/sandbox/wallets/fund').send({
          amount: 25_000,
        }),
        201,
        'fund',
      ).body as PaymentResponseDto;

      expect(funded).toMatchObject({ status: 'successful', provider: 'mock' });
      expect(await available()).toBe(25_000);
      // A real signed webhook was received and processed.
      await eventually(async () => {
        const [event] = await dataSource.query<{ status: string }[]>(
          'SELECT status FROM webhook_events',
        );
        expect(event?.status).toBe('processed');
      });
    });
  });

  describe('simulations (development)', () => {
    beforeEach(() => boot());

    it('completes or fails my pending payments, and only mine', async () => {
      const start = async (): Promise<PaymentResponseDto> =>
        (
          await asAda('post', '/v1/payments')
            .set('Idempotency-Key', `pay-${++keys}`)
            .send({ amount: 5_000, currency: 'USD' })
            .expect(201)
        ).body as PaymentResponseDto;

      const paid = await start();
      expect(
        (
          (
            await asAda('post', `/v1/sandbox/payments/${paid.id}/complete`)
              .send({ outcome: 'successful' })
              .expect(200)
          ).body as PaymentResponseDto
        ).status,
      ).toBe('successful');

      const failed = await start();
      expect(
        (
          (
            await asAda('post', `/v1/sandbox/payments/${failed.id}/complete`)
              .send({ outcome: 'failed' })
              .expect(200)
          ).body as PaymentResponseDto
        ).status,
      ).toBe('failed');

      const again = await asAda(
        'post',
        `/v1/sandbox/payments/${paid.id}/complete`,
      ).send({ outcome: 'successful' });
      expect(again.body).toMatchObject({ code: 'NOT_SIMULATABLE' });

      const eve = await registerUser(app, 'eve@example.com');
      await as(
        eve.tokens.accessToken,
        'post',
        `/v1/sandbox/payments/${paid.id}/complete`,
      )
        .send({ outcome: 'failed' })
        .expect(404);
      expect(await available()).toBe(5_000);
    });

    it('simulates amount mismatches', async () => {
      const payment = (
        await asAda('post', '/v1/payments')
          .set('Idempotency-Key', 'short')
          .send({ amount: 5_000, currency: 'USD' })
          .expect(201)
      ).body as PaymentResponseDto;
      const settled = (
        await asAda('post', `/v1/sandbox/payments/${payment.id}/complete`)
          .send({ outcome: 'successful', collectedAmount: 4_000 })
          .expect(200)
      ).body as PaymentResponseDto;
      expect(settled).toMatchObject({
        status: 'failed',
        failureCode: 'AMOUNT_MISMATCH',
      });
    });

    it('still completes payments and payouts after the mock provider restarts', async () => {
      await asAda('post', '/v1/sandbox/wallets/fund')
        .send({ amount: 20_000 })
        .expect(201);
      const payment = (
        await asAda('post', '/v1/payments')
          .set('Idempotency-Key', `restart-${++keys}`)
          .send({ amount: 5_000, currency: 'USD' })
          .expect(201)
      ).body as PaymentResponseDto;
      const destination = (
        (
          await asAda('post', '/v1/payout-destinations')
            .send({
              currency: 'USD',
              bankCode: '058',
              accountNumber: '1234560002',
            })
            .expect(201)
        ).body as PayoutDestinationResponseDto
      ).id;
      const payout = (
        await asAda('post', '/v1/payouts')
          .set('Idempotency-Key', `restart-${++keys}`)
          .send({ destinationId: destination, amount: 1_000 })
          .expect(201)
      ).body as PayoutResponseDto;
      expect(payout.status).toBe('processing');

      // A restart: the in-memory mock forgets everything; FinStack doesn't.
      app.get(MockPaymentProvider).forgetEverything();

      const paid = (
        await asAda('post', `/v1/sandbox/payments/${payment.id}/complete`)
          .send({ outcome: 'successful' })
          .expect(200)
      ).body as PaymentResponseDto;
      expect(paid.status).toBe('successful');
      const settled = (
        await asAda('post', `/v1/sandbox/payouts/${payout.id}/complete`)
          .send({ outcome: 'successful' })
          .expect(200)
      ).body as PayoutResponseDto;
      expect(settled.status).toBe('successful');
      expect(await available()).toBe(20_000 + 5_000 - 1_000);
    });

    it('drives payouts with test bank accounts', async () => {
      await asAda('post', '/v1/sandbox/wallets/fund')
        .send({ amount: 30_000 })
        .expect(201);
      const destination = async (accountNumber: string): Promise<string> =>
        (
          (
            await asAda('post', '/v1/payout-destinations')
              .send({ currency: 'USD', bankCode: '058', accountNumber })
              .expect(201)
          ).body as PayoutDestinationResponseDto
        ).id;
      const payout = async (
        destinationId: string,
      ): Promise<PayoutResponseDto> =>
        (
          await asAda('post', '/v1/payouts')
            .set('Idempotency-Key', `payout-${++keys}`)
            .send({ destinationId, amount: 1_000 })
            .expect(201)
        ).body as PayoutResponseDto;

      // Ordinary accounts: paid at once.
      expect((await payout(await destination('1234567890'))).status).toBe(
        'successful',
      );
      // Ending 0001: the bank rejects it.
      expect((await payout(await destination('1234560001'))).status).toBe(
        'failed',
      );
      // Ending 0002: pending until simulated.
      const pending = await payout(await destination('1234560002'));
      expect(pending.status).toBe('processing');
      const returned = (
        await asAda('post', `/v1/sandbox/payouts/${pending.id}/complete`)
          .send({ outcome: 'failed' })
          .expect(200)
      ).body as PayoutResponseDto;
      expect(returned.status).toBe('failed');

      expect(await available()).toBe(29_000);
    });

    it('works for organizations with a scoped API key', async () => {
      const orgId = (
        (
          await asAda('post', '/v1/organizations')
            .send({ name: 'Acme' })
            .expect(201)
        ).body as OrganizationResponseDto
      ).id;
      await asAda('post', `/v1/organizations/${orgId}/wallets`)
        .send({})
        .expect(201);
      const { key } = (
        await asAda('post', `/v1/organizations/${orgId}/api-keys`)
          .send({ name: 'Tests', scopes: ['payments:create', 'wallets:read'] })
          .expect(201)
      ).body as CreatedApiKeyResponseDto;

      const funded = (
        await request(app.getHttpServer())
          .post(`/v1/organizations/${orgId}/sandbox/wallets/fund`)
          .set('X-API-Key', key)
          .send({ amount: 7_500 })
          .expect(201)
      ).body as PaymentResponseDto;
      expect(funded.status).toBe('successful');

      const wallets = (
        await request(app.getHttpServer())
          .get(`/v1/organizations/${orgId}/wallets`)
          .set('X-API-Key', key)
          .expect(200)
      ).body as WalletResponseDto[];
      expect(wallets[0]?.balances.available).toBe(7_500);
    });
  });

  it('does not exist where the mock provider is off', async () => {
    await boot({
      PAYMENT_PROVIDERS: 'paystack',
      DEFAULT_PAYMENT_PROVIDER: 'paystack',
      PAYSTACK_SECRET_KEY: 'sk_test_abc123',
    });
    const response = await asAda('post', '/v1/sandbox/wallets/fund').send({
      amount: 1_000,
    });
    expect(response.status).toBe(404);
  });
});
