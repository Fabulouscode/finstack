import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
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
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';

describe('Payments: first vertical slice (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let mock: MockPaymentProvider;
  let token: string;
  let keyCounter = 0;

  const authed = (method: 'get' | 'post', path: string): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

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

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    mock = app.get(MockPaymentProvider);
    await resetDatabase(dataSource);
    await app
      .get(AdminRateProvider)
      .setRate({ base: 'USD', quote: 'NGN', rate: '1550', userId: null });

    // Step 1-2: create a user and a (USD, primary) wallet.
    token = (await registerUser(app, 'ada@example.com')).tokens.accessToken;
    await authed('post', '/v1/wallets').send({}).expect(201);
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

  it('completes the slice: NGN payment -> signed webhook -> verified -> converted -> USD wallet', async () => {
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

    // Step 4-5: the provider sends a signed webhook; it is verified and processed.
    const ack = await payProvider(payment);
    expect(ack.body).toEqual({ received: true, duplicate: false });

    // Step 6-9: transaction settled, ledger posted, wallet credited.
    const settled = await getPayment(payment.id);
    expect(settled).toMatchObject({ status: 'successful', failureCode: null });
    expect(settled.completedAt).not.toBeNull();
    await expect(walletBalance()).resolves.toBe(990); // $9.90

    // Step 10: retrieve the transaction.
    const history = (await authed('get', '/v1/transactions').expect(200))
      .body as TransactionsPageDto;
    expect(history.data).toEqual([
      expect.objectContaining({
        id: payment.transactionId,
        type: 'payment',
        status: 'successful',
        direction: 'outgoing',
        amount: 1_550_000,
        currency: 'NGN',
      }),
    ]);
  });

  it('credits same-currency payments directly, without conversion', async () => {
    const payment = await startPayment({ amount: 5_000, currency: 'USD' });
    expect(payment.conversion).toBeNull();

    await payProvider(payment);

    await expect(walletBalance()).resolves.toBe(5_000);
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

      await expect(
        dataSource.query('SELECT 1 FROM webhook_events'),
      ).resolves.toHaveLength(0);
      await expect(getPayment(payment.id)).resolves.toMatchObject({
        status: 'pending',
      });
    });

    it('marks a declined payment as failed', async () => {
      const payment = await startPayment({ amount: 5_000, currency: 'USD' });

      await payProvider(payment, 'failed');

      await expect(getPayment(payment.id)).resolves.toMatchObject({
        status: 'failed',
        failureCode: 'PAYMENT_FAILED',
      });
      await expect(walletBalance()).resolves.toBe(0);
    });

    it('never credits when the provider collected a different amount', async () => {
      const payment = await startPayment({ amount: 5_000, currency: 'USD' });

      await payProvider(payment, 'successful', { amount: 4_000n });

      await expect(getPayment(payment.id)).resolves.toMatchObject({
        status: 'failed',
        failureCode: 'AMOUNT_MISMATCH',
      });
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

    it('records a webhook it could not process and settles it on retry', async () => {
      const payment = await startPayment({ amount: 5_000, currency: 'USD' });
      jest
        .spyOn(mock, 'verifyPayment')
        .mockRejectedValueOnce(
          new PaymentProviderError('503 from provider', true),
        );

      await payProvider(payment); // provider still gets 200: the event is stored
      const [event] = await dataSource.query<
        { id: string; status: string; attempts: number }[]
      >('SELECT id, status, attempts FROM webhook_events');
      expect(event).toMatchObject({ status: 'failed', attempts: 1 });
      await expect(walletBalance()).resolves.toBe(0);

      await app.get(WebhooksService).process(event?.id ?? '');

      await expect(walletBalance()).resolves.toBe(5_000);
      await expect(getPayment(payment.id)).resolves.toMatchObject({
        status: 'successful',
      });
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

      await expect(walletBalance()).resolves.toBe(990);
      const [txn] = await dataSource.query<
        { metadata: Record<string, unknown> }[]
      >('SELECT metadata FROM transactions WHERE id = $1', [
        payment.transactionId,
      ]);
      expect(txn?.metadata).toMatchObject({ lateFxRequote: true });
    });

    it('holds the payment while the wallet is frozen, then settles on retry', async () => {
      const payment = await startPayment({ amount: 5_000, currency: 'USD' });
      await dataSource.query(`UPDATE wallets SET status = 'frozen'`);

      await payProvider(payment);
      await expect(getPayment(payment.id)).resolves.toMatchObject({
        status: 'pending',
      });

      await dataSource.query(`UPDATE wallets SET status = 'active'`);
      const [event] = await dataSource.query<{ id: string }[]>(
        'SELECT id FROM webhook_events',
      );
      await app.get(WebhooksService).process(event?.id ?? '');

      await expect(walletBalance()).resolves.toBe(5_000);
    });

    it('requires a wallet before accepting payments', async () => {
      const otherToken = (await registerUser(app, 'nowallet@example.com'))
        .tokens.accessToken;

      const response = await request(app.getHttpServer())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${otherToken}`)
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

    await expect(getPayment(payment.id)).resolves.toMatchObject({
      status: 'successful',
    });
  });
});
