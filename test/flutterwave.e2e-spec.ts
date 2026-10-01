import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { LedgerService } from '../src/ledger/ledger.service';
import { FLUTTERWAVE_SIGNATURE_HEADER } from '../src/payment-providers/flutterwave/flutterwave.provider';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import {
  PayoutDestinationResponseDto,
  PayoutResponseDto,
} from '../src/payouts/dto/payout.dto';
import { RefundResponseDto } from '../src/refunds/dto/refund.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { FakeFlutterwave } from './utils/fake-flutterwave';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

const SECRET = 'FLWSECK_TEST-e2esecret123-X';
const HASH = 'e2e-flutterwave-secret-hash';

describe('Flutterwave provider (e2e, fake Flutterwave API)', () => {
  const originalEnv = process.env;
  let flutterwave: FakeFlutterwave;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let token: string;
  let keyCounter = 0;

  const as = (
    bearer: string,
    method: 'get' | 'post',
    path: string,
  ): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${bearer}`);
  const authed = (method: 'get' | 'post', path: string): request.Test =>
    as(token, method, path);

  const startPayment = (amount: number): request.Test =>
    authed('post', '/v1/payments')
      .set('Idempotency-Key', `fw-${++keyCounter}`)
      .send({ amount, currency: 'NGN' });

  const deliver = (rawBody: Buffer, hash: string): request.Test =>
    request(app.getHttpServer())
      .post('/v1/webhooks/flutterwave')
      .set('Content-Type', 'application/json')
      .set(FLUTTERWAVE_SIGNATURE_HEADER, hash)
      .send(rawBody.toString('utf8'));

  const balances = async (): Promise<WalletResponseDto['balances']> =>
    (
      (await authed('get', '/v1/wallets/primary').expect(200))
        .body as WalletResponseDto
    ).balances;

  /** Pays `amount` kobo through Flutterwave and waits for the credit. */
  const paid = async (amount: number): Promise<PaymentResponseDto> => {
    const payment = expectStatus(await startPayment(amount), 201, 'pay')
      .body as PaymentResponseDto;
    const { rawBody, hash } = flutterwave.complete(
      payment.reference,
      'successful',
    );
    await deliver(rawBody, hash).expect(200);
    await eventually(async () => {
      expect((await balances()).available).toBe(amount);
    });
    return payment;
  };

  beforeEach(async () => {
    flutterwave = new FakeFlutterwave(SECRET, HASH);
    const baseUrl = await flutterwave.start();
    process.env = {
      ...originalEnv,
      AUTH_RATE_LIMIT_MAX: '50',
      PAYMENT_PROVIDERS: 'flutterwave',
      DEFAULT_PAYMENT_PROVIDER: 'flutterwave',
      FLUTTERWAVE_SECRET_KEY: SECRET,
      FLUTTERWAVE_WEBHOOK_SECRET_HASH: HASH,
      FLUTTERWAVE_BASE_URL: baseUrl,
      FLUTTERWAVE_REDIRECT_URL: 'https://app.example.com/paid',
      FLUTTERWAVE_TIMEOUT_MS: '2000',
      DEFAULT_WALLET_CURRENCY: 'NGN',
      ALLOWED_WALLET_CURRENCIES: 'NGN',
    };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    await resetDatabase(dataSource);
    token = (await registerUser(app, 'ada@example.com')).tokens.accessToken;
    expectStatus(await authed('post', '/v1/wallets').send({}), 201, 'wallet');
  });

  afterEach(async () => {
    await expect(
      app.get(LedgerService).findBalanceDiscrepancies(),
    ).resolves.toEqual([]);
    await app.close();
    await flutterwave.stop();
    process.env = originalEnv;
  });

  it('charges NGN in major units and credits the exact kobo amount once', async () => {
    // ₦15,500.50: the kobo must survive the trip to major units and back.
    const payment = expectStatus(await startPayment(1_550_050), 201, 'pay')
      .body as PaymentResponseDto;

    expect(payment).toMatchObject({
      provider: 'flutterwave',
      status: 'pending',
      providerReference: payment.reference,
    });
    expect(payment.authorizationUrl).toMatch(
      /^https:\/\/checkout\.flutterwave\.test\//,
    );
    expect(flutterwave.requests[0]).toMatchObject({
      method: 'POST',
      path: '/payments',
      body: {
        tx_ref: payment.reference,
        amount: 15500.5,
        currency: 'NGN',
        customer: { email: 'ada@example.com' },
      },
    });

    const { rawBody, hash } = flutterwave.complete(
      payment.reference,
      'successful',
    );
    await deliver(rawBody, hash).expect(200, {
      received: true,
      duplicate: false,
    });
    await deliver(rawBody, hash).expect(200, {
      received: true,
      duplicate: true,
    });

    await eventually(async () => {
      expect((await balances()).available).toBe(1_550_050);
    });
    // FinStack asked Flutterwave for the real state instead of trusting the webhook.
    expect(
      flutterwave.requests.some(
        (r) =>
          r.path ===
          `/transactions/verify_by_reference?tx_ref=${payment.reference}`,
      ),
    ).toBe(true);
  });

  it('rejects webhooks without the secret hash and stores nothing', async () => {
    const payment = (await startPayment(500_000).expect(201))
      .body as PaymentResponseDto;
    const { rawBody } = flutterwave.complete(payment.reference, 'successful');

    const forged = await deliver(rawBody, 'not-the-secret-hash').expect(401);
    expect(forged.body).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
    await request(app.getHttpServer())
      .post('/v1/webhooks/flutterwave')
      .set('Content-Type', 'application/json')
      .send(rawBody.toString('utf8'))
      .expect(401);

    await expect(
      dataSource.query('SELECT 1 FROM webhook_events'),
    ).resolves.toHaveLength(0);
    expect((await balances()).available).toBe(0);
  });

  it('never credits when Flutterwave collected a different amount', async () => {
    const payment = (await startPayment(500_000).expect(201))
      .body as PaymentResponseDto;
    // ₦4,999.99 instead of ₦5,000.00: off by one kobo.
    const { rawBody, hash } = flutterwave.complete(
      payment.reference,
      'successful',
      { amount: 4999.99 },
    );
    await deliver(rawBody, hash).expect(200);

    await eventually(async () => {
      const current = (
        await authed('get', `/v1/payments/${payment.id}`).expect(200)
      ).body as PaymentResponseDto;
      expect(current).toMatchObject({
        status: 'failed',
        failureCode: 'AMOUNT_MISMATCH',
      });
    });
    expect((await balances()).available).toBe(0);
  });

  it('stays pending through a Flutterwave outage and recovers on retry', async () => {
    flutterwave.failNext(503);
    const key = 'fw-outage';
    const send = (): request.Test =>
      authed('post', '/v1/payments')
        .set('Idempotency-Key', key)
        .send({ amount: 500_000, currency: 'NGN' });

    const outage = await send().expect(503);
    expect(outage.body).toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' });
    const retry = (await send().expect(201)).body as PaymentResponseDto;
    expect(retry.authorizationUrl).not.toBeNull();
  });

  it('refunds part of a payment through Flutterwave', async () => {
    const payment = await paid(500_000);
    await registerUser(app, 'admin@example.com');
    await dataSource.query(
      `UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'`,
    );
    const adminToken = (
      expectStatus(
        await request(app.getHttpServer()).post('/v1/auth/login').send({
          email: 'admin@example.com',
          password: 'correct-horse-battery-staple',
        }),
        200,
        'admin login',
      ).body as { tokens: { accessToken: string } }
    ).tokens.accessToken;

    const refund = expectStatus(
      await as(adminToken, 'post', `/v1/admin/payments/${payment.id}/refunds`)
        .set('Idempotency-Key', 'fw-refund-1')
        .send({ amount: 150_050, reason: 'Damaged item' }),
      201,
      'refund',
    ).body as RefundResponseDto;

    expect(refund).toMatchObject({ status: 'successful', amount: 150_050 });
    const refundCall = flutterwave.requests.find((r) =>
      /^\/transactions\/\d+\/refund$/.test(r.path),
    );
    expect(refundCall?.body).toEqual({
      amount: 1500.5,
      comments: refund.reference,
    });
    await expect(balances()).resolves.toMatchObject({
      available: 349_950,
      reserved: 0,
    });
  });

  it('pays out to a saved beneficiary and settles from the transfer webhook', async () => {
    await paid(500_000);

    const destination = expectStatus(
      await authed('post', '/v1/payout-destinations').send({
        currency: 'NGN',
        bankCode: '044',
        accountNumber: '0690000034',
      }),
      201,
      'destination',
    ).body as PayoutDestinationResponseDto;
    expect(destination).toMatchObject({
      provider: 'flutterwave',
      accountName: 'ADA LOVELACE',
      bankName: 'ACCESS BANK NIGERIA',
      accountNumberLast4: '0034',
    });

    const payout = expectStatus(
      await authed('post', '/v1/payouts')
        .set('Idempotency-Key', 'fw-payout-1')
        .send({ destinationId: destination.id, amount: 100_000 }),
      201,
      'payout',
    ).body as PayoutResponseDto;
    expect(payout.status).toBe('processing');
    expect(flutterwave.transfers).toHaveLength(1);
    expect(flutterwave.transfers[0]).toMatchObject({
      reference: payout.reference,
      amount: 1000,
      currency: 'NGN',
    });

    const { rawBody, hash } = flutterwave.settleTransfer(
      payout.reference,
      'SUCCESSFUL',
    );
    await deliver(rawBody, hash).expect(200);

    await eventually(async () => {
      const current = (
        await authed('get', `/v1/payouts/${payout.id}`).expect(200)
      ).body as PayoutResponseDto;
      expect(current.status).toBe('successful');
    });
    await expect(balances()).resolves.toMatchObject({
      available: 400_000,
      reserved: 0,
    });
    // Sent exactly once.
    expect(flutterwave.transfers).toHaveLength(1);
  });
});
