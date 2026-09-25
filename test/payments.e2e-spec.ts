import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { LoggingEventHandler } from '../src/events/logging-event.handler';
import { AdminRateProvider } from '../src/fx/admin-rate.provider';
import { LedgerService } from '../src/ledger/ledger.service';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../src/payment-providers/mock/mock-payment.provider';
import { PaymentProviderError } from '../src/payment-providers/payment-provider';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import { TransactionsPageDto } from '../src/transactions/dto/transaction.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

interface WebhookEventRow {
  id: string;
  status: string;
  attempts: number;
  outcome: string | null;
}

describe('Payments: first vertical slice (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let mock: MockPaymentProvider;
  let token: string;
  let keyCounter = 0;

  const authed = (
    method: 'get' | 'post',
    path: string,
    as = token,
  ): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${as}`);

  const startPayment = async (
    body: object,
    key = `pay-${++keyCounter}`,
  ): Promise<PaymentResponseDto> =>
    (
      await authed('post', '/v1/payments')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201)
    ).body as PaymentResponseDto;

  const deliverWebhook = (rawBody: Buffer, signature: string): request.Test =>
    request(app.getHttpServer())
      .post('/v1/webhooks/mock')
      .set('Content-Type', 'application/json')
      .set(MOCK_SIGNATURE_HEADER, signature)
      .send(rawBody.toString('utf8'));

  const payProvider = async (
    payment: PaymentResponseDto,
    outcome: 'successful' | 'failed' = 'successful',
    overrides: { amount?: bigint } = {},
  ): Promise<request.Response> => {
    const { rawBody, signature } = mock.simulateOutcome(
      payment.providerReference ?? '',
      outcome,
      overrides,
    );
    return deliverWebhook(rawBody, signature).expect(200);
  };

  const getPayment = async (id: string): Promise<PaymentResponseDto> =>
    (await authed('get', `/v1/payments/${id}`).expect(200))
      .body as PaymentResponseDto;

  const walletBalance = async (): Promise<number> =>
    (
      (await authed('get', '/v1/wallets/primary').expect(200))
        .body as WalletResponseDto
    ).balances.available;

  const webhookEvents = (): Promise<WebhookEventRow[]> =>
    dataSource.query<WebhookEventRow[]>(
      'SELECT id, status, attempts, outcome FROM webhook_events ORDER BY received_at',
    );

  /** Waits for the webhook worker to settle the payment. */
  const settled = (id: string, status: string): Promise<PaymentResponseDto> =>
    eventually(async () => {
      const payment = await getPayment(id);
      expect(payment.status).toBe(status);
      return payment;
    });

  const balanceBecomes = (expected: number): Promise<void> =>
    eventually(async () => {
      await expect(walletBalance()).resolves.toBe(expected);
    });

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    mock = app.get(MockPaymentProvider);
    await resetDatabase(dataSource);
    await app
      .get(AdminRateProvider)
      .setRate({ base: 'USD', quote: 'NGN', rate: '1550', userId: null });

    // Steps 1-2: a user with a (USD, primary) wallet.
    token = (await registerUser(app, 'ada@example.com')).tokens.accessToken;
    expectStatus(
      await authed('post', '/v1/wallets').send({}),
      201,
      'open wallet',
    );
  });

  afterEach(async () => {
    const ledger = app.get(LedgerService);
    await expect(ledger.findBalanceDiscrepancies()).resolves.toEqual([]);
    for (const currency of ['USD', 'NGN']) {
      const trial = await ledger.trialBalance(currency);
      expect(trial.debit).toBe(trial.credit);
    }
    jest.restoreAllMocks();
    await app.close();
    process.env = originalEnv;
  });

  it('completes the slice: NGN payment -> signed webhook -> queue -> verified -> converted -> USD wallet -> event', async () => {
    const onEvent = jest.spyOn(app.get(LoggingEventHandler), 'handle');

    // Step 3: initialise a payment in NGN; the wallet is USD, so a quote is locked.
    const payment = await startPayment({ amount: 1_550_000, currency: 'NGN' });
    expect(payment).toMatchObject({
      status: 'pending',
      provider: 'mock',
      amount: 1_550_000,
      currency: 'NGN',
      conversion: {
        amount: 990,
        currency: 'USD',
        rate: '1550',
        spreadBps: 100,
      },
    });
    expect(payment.authorizationUrl).toContain(payment.providerReference);

    // Steps 4-5: the provider sends a signed webhook; it is verified and stored.
    const ack = await payProvider(payment);
    expect(ack.body).toEqual({ received: true, duplicate: false });

    // Steps 6-9: the worker settles it: transaction, ledger, wallet.
    const done = await settled(payment.id, 'successful');
    expect(done.completedAt).not.toBeNull();
    await expect(walletBalance()).resolves.toBe(990); // $9.90

    // Step 10: the outbox event is published and handled.
    await eventually(() => {
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'payment.successful',
          aggregateId: payment.transactionId,
          data: expect.objectContaining({
            charged: { amount: '1550000', currency: 'NGN' },
            credited: { amount: '990', currency: 'USD' },
          }) as object,
        }),
      );
      return Promise.resolve();
    });

    // Step 11: retrieve the transaction.
    const history = (await authed('get', '/v1/transactions').expect(200))
      .body as TransactionsPageDto;
    expect(history.data).toEqual([
      expect.objectContaining({
        id: payment.transactionId,
        type: 'payment',
        status: 'successful',
        amount: 1_550_000,
        currency: 'NGN',
      }),
    ]);
  });

  it('credits same-currency payments directly, without conversion', async () => {
    const payment = await startPayment({ amount: 5_000, currency: 'USD' });
    expect(payment.conversion).toBeNull();

    await payProvider(payment);

    await balanceBecomes(5_000);
  });

  describe('failure scenarios', () => {
    it('acknowledges a duplicate webhook without crediting twice', async () => {
      const payment = await startPayment({ amount: 5_000, currency: 'USD' });
      const { rawBody, signature } = mock.simulateOutcome(
        payment.providerReference ?? '',
        'successful',
      );

      await deliverWebhook(rawBody, signature).expect(200, {
        received: true,
        duplicate: false,
      });
      await deliverWebhook(rawBody, signature).expect(200, {
        received: true,
        duplicate: true,
      });

      await eventually(async () => {
        expect(await webhookEvents()).toEqual([
          expect.objectContaining({ status: 'processed', outcome: 'credited' }),
        ]);
      });
      await expect(walletBalance()).resolves.toBe(5_000);
    });

    it('rejects a webhook with a bad signature and stores nothing', async () => {
      const payment = await startPayment({ amount: 5_000, currency: 'USD' });
      const { rawBody, signature } = mock.simulateOutcome(
        payment.providerReference ?? '',
        'successful',
      );
      const tampered = Buffer.from(
        rawBody.toString().replace('"5000"', '"9999999"'),
      );

      const response = await deliverWebhook(tampered, signature).expect(401);
      expect(response.body).toMatchObject({
        code: 'INVALID_WEBHOOK_SIGNATURE',
      });
      await deliverWebhook(rawBody, 'f'.repeat(64)).expect(401);

      await expect(webhookEvents()).resolves.toHaveLength(0);
      await expect(getPayment(payment.id)).resolves.toMatchObject({
        status: 'pending',
      });
    });

    it('marks a declined payment as failed', async () => {
      const payment = await startPayment({ amount: 5_000, currency: 'USD' });

      await payProvider(payment, 'failed');

      const failed = await settled(payment.id, 'failed');
      expect(failed.failureCode).toBe('PAYMENT_FAILED');
      await expect(walletBalance()).resolves.toBe(0);
    });

    it('never credits when the provider collected a different amount', async () => {
      const payment = await startPayment({ amount: 5_000, currency: 'USD' });

      await payProvider(payment, 'successful', { amount: 4_000n });

      const failed = await settled(payment.id, 'failed');
      expect(failed.failureCode).toBe('AMOUNT_MISMATCH');
      await expect(walletBalance()).resolves.toBe(0);
    });

    it('settles once when the verify call and the webhook race', async () => {
      const payment = await startPayment({ amount: 5_000, currency: 'USD' });
      const { rawBody, signature } = mock.simulateOutcome(
        payment.providerReference ?? '',
        'successful',
      );

      const responses = await Promise.all([
        deliverWebhook(rawBody, signature),
        authed('post', `/v1/payments/${payment.id}/verify`),
        authed('post', `/v1/payments/${payment.id}/verify`),
        authed('post', `/v1/payments/${payment.id}/verify`),
      ]);

      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      await eventually(async () => {
        expect((await webhookEvents())[0]?.status).toBe('processed');
      });
      await expect(walletBalance()).resolves.toBe(5_000);
    });

    it('stays pending when the provider is down at checkout, and a retry with the same key recovers', async () => {
      jest
        .spyOn(mock, 'initializePayment')
        .mockRejectedValueOnce(
          new PaymentProviderError('connect ETIMEDOUT', true),
        );

      const outage = await authed('post', '/v1/payments')
        .set('Idempotency-Key', 'pay-outage')
        .send({ amount: 5_000, currency: 'USD' })
        .expect(503);
      expect(outage.body).toMatchObject({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      });

      const retry = await startPayment(
        { amount: 5_000, currency: 'USD' },
        'pay-outage',
      );
      expect(retry).toMatchObject({ status: 'pending' });
      expect(retry.authorizationUrl).not.toBeNull();
      await expect(
        dataSource.query('SELECT 1 FROM payments'),
      ).resolves.toHaveLength(1);
    });

    it('retries automatically when the provider is down during verification', async () => {
      const payment = await startPayment({ amount: 5_000, currency: 'USD' });
      jest
        .spyOn(mock, 'verifyPayment')
        .mockRejectedValueOnce(
          new PaymentProviderError('503 from provider', true),
        );

      await payProvider(payment); // the provider still gets 200: the event is stored

      await settled(payment.id, 'successful');
      const [event] = await webhookEvents();
      expect(event).toMatchObject({ status: 'processed', attempts: 2 });
      await expect(walletBalance()).resolves.toBe(5_000);
    });

    it('re-quotes a payment made after its FX quote expired, and flags it', async () => {
      const payment = await startPayment({
        amount: 1_550_000,
        currency: 'NGN',
      });
      await dataSource.query(
        `UPDATE fx_quotes SET expires_at = now() - interval '1 minute'`,
      );

      await payProvider(payment);

      await balanceBecomes(990);
      const [txn] = await dataSource.query<
        { metadata: Record<string, unknown> }[]
      >('SELECT metadata FROM transactions WHERE id = $1', [
        payment.transactionId,
      ]);
      expect(txn?.metadata).toMatchObject({ lateFxRequote: true });
    });

    it('keeps retrying while the wallet is frozen, and settles once it is unfrozen', async () => {
      const payment = await startPayment({ amount: 5_000, currency: 'USD' });
      await dataSource.query(`UPDATE wallets SET status = 'frozen'`);

      await payProvider(payment);
      await eventually(async () => {
        expect((await webhookEvents())[0]).toMatchObject({ status: 'failed' });
      });
      await expect(getPayment(payment.id)).resolves.toMatchObject({
        status: 'pending',
      });

      await dataSource.query(`UPDATE wallets SET status = 'active'`);

      await balanceBecomes(5_000);
    });

    it('dead-letters an event after the last retry; an admin replays it', async () => {
      const payment = await startPayment({ amount: 5_000, currency: 'USD' });
      await dataSource.query(`UPDATE wallets SET status = 'frozen'`);
      await registerUser(app, 'admin@example.com');
      await dataSource.query(
        `UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'`,
      );
      const adminToken = (
        (
          await request(app.getHttpServer())
            .post('/v1/auth/login')
            .send({
              email: 'admin@example.com',
              password: 'correct-horse-battery-staple',
            })
            .expect(200)
        ).body as { tokens: { accessToken: string } }
      ).tokens.accessToken;

      await payProvider(payment);

      // WEBHOOK_MAX_ATTEMPTS=5 in tests: 5 attempts, then the event stays failed.
      await eventually(
        async () => {
          expect((await webhookEvents())[0]).toMatchObject({
            status: 'failed',
            attempts: 5,
          });
        },
        { timeoutMs: 15_000 },
      );
      const listed = await authed(
        'get',
        '/v1/admin/webhook-events?status=failed',
        adminToken,
      ).expect(200);
      expect(listed.body).toHaveLength(1);
      await authed('get', '/v1/admin/webhook-events', token).expect(403);

      await dataSource.query(`UPDATE wallets SET status = 'active'`);
      const [event] = await webhookEvents();
      await authed(
        'post',
        `/v1/admin/webhook-events/${event?.id}/replay`,
        adminToken,
      ).expect(201);

      await balanceBecomes(5_000);
      await authed(
        'post',
        `/v1/admin/webhook-events/${event?.id}/replay`,
        adminToken,
      ).expect(409);

      const queues = await authed('get', '/v1/admin/queues', adminToken).expect(
        200,
      );
      expect(queues.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ queue: 'webhooks' }),
        ]),
      );
    }, 30_000);

    it('requires a wallet before accepting payments', async () => {
      const otherToken = (await registerUser(app, 'nowallet@example.com'))
        .tokens.accessToken;

      const response = await authed('post', '/v1/payments', otherToken)
        .set('Idempotency-Key', 'k')
        .send({ amount: 100, currency: 'USD' })
        .expect(404);
      expect(response.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
    });

    it('validates the request and requires an Idempotency-Key', async () => {
      await authed('post', '/v1/payments')
        .send({ amount: 100, currency: 'USD' })
        .expect(400);
      for (const body of [
        { amount: '100', currency: 'USD' },
        { amount: 0, currency: 'USD' },
        { amount: 100, currency: 'XXX' },
        { amount: 100, currency: 'USD', provider: 'paypal' },
      ]) {
        await authed('post', '/v1/payments')
          .set('Idempotency-Key', 'v')
          .send(body)
          .expect(400);
      }
    });
  });

  it('completes a mock checkout through the dev endpoint', async () => {
    const payment = await startPayment({ amount: 5_000, currency: 'USD' });

    await authed(
      'post',
      `/v1/dev/mock-provider/payments/${payment.providerReference}/complete`,
    )
      .send({ outcome: 'successful' })
      .expect(200);

    await settled(payment.id, 'successful');
  });

  it('reports Redis in the readiness check', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(response.body).toMatchObject({
      info: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });
});
