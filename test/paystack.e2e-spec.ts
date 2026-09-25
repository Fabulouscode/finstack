import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AdminRateProvider } from '../src/fx/admin-rate.provider';
import { PAYSTACK_SIGNATURE_HEADER } from '../src/payment-providers/paystack/paystack.provider';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { FakePaystack } from './utils/fake-paystack';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

const SECRET = 'sk_test_e2esecret123';

describe('Paystack provider (e2e, fake Paystack API)', () => {
  const originalEnv = process.env;
  let paystack: FakePaystack;
  let app: INestApplication<App>;
  let token: string;
  let keyCounter = 0;

  const authed = (method: 'get' | 'post', path: string): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const startPayment = (
    body: object,
    key = `ps-${++keyCounter}`,
  ): request.Test =>
    authed('post', '/v1/payments').set('Idempotency-Key', key).send(body);

  const deliver = (rawBody: Buffer, signature: string): request.Test =>
    request(app.getHttpServer())
      .post('/v1/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set(PAYSTACK_SIGNATURE_HEADER, signature)
      .send(rawBody.toString('utf8'));

  const balance = async (): Promise<number> =>
    (
      (await authed('get', '/v1/wallets/primary').expect(200))
        .body as WalletResponseDto
    ).balances.available;

  beforeEach(async () => {
    paystack = new FakePaystack(SECRET);
    const baseUrl = await paystack.start();
    process.env = {
      ...originalEnv,
      AUTH_RATE_LIMIT_MAX: '50',
      PAYMENT_PROVIDERS: 'paystack,mock',
      DEFAULT_PAYMENT_PROVIDER: 'paystack',
      PAYSTACK_SECRET_KEY: SECRET,
      PAYSTACK_BASE_URL: baseUrl,
      PAYSTACK_TIMEOUT_MS: '2000',
    };
    app = await createTestApp();
    await resetDatabase(app.get(DataSource));
    await app
      .get(AdminRateProvider)
      .setRate({ base: 'USD', quote: 'NGN', rate: '1550', userId: null });
    token = (await registerUser(app, 'ada@example.com')).tokens.accessToken;
    expectStatus(
      await authed('post', '/v1/wallets').send({}),
      201,
      'open wallet',
    );
  });

  afterEach(async () => {
    await app.close();
    await paystack.stop();
    process.env = originalEnv;
  });

  it('charges NGN through Paystack, verifies the signed webhook and credits the USD wallet', async () => {
    const payment = expectStatus(
      await startPayment({ amount: 1_550_000, currency: 'NGN' }),
      201,
      'start payment',
    ).body as PaymentResponseDto;

    expect(payment).toMatchObject({
      provider: 'paystack',
      status: 'pending',
      providerReference: payment.reference,
      conversion: { amount: 990, currency: 'USD' },
    });
    expect(payment.authorizationUrl).toMatch(
      /^https:\/\/checkout\.paystack\.test\//,
    );
    expect(paystack.requests[0]).toMatchObject({
      method: 'POST',
      path: '/transaction/initialize',
      authorization: `Bearer ${SECRET}`,
    });

    const { rawBody, signature } = paystack.complete(
      payment.reference,
      'success',
    );
    await deliver(rawBody, signature).expect(200, {
      received: true,
      duplicate: false,
    });
    await deliver(rawBody, signature).expect(200, {
      received: true,
      duplicate: true,
    });

    await eventually(async () => {
      await expect(balance()).resolves.toBe(990);
    });
    // FinStack asked Paystack for the real state instead of trusting the webhook.
    expect(
      paystack.requests.some(
        (r) => r.path === `/transaction/verify/${payment.reference}`,
      ),
    ).toBe(true);
  });

  it('rejects webhooks not signed with the Paystack secret', async () => {
    const payment = (
      await startPayment({ amount: 5_000, currency: 'USD' }).expect(201)
    ).body as PaymentResponseDto;
    const { rawBody } = paystack.complete(payment.reference, 'success');

    const forged = await deliver(rawBody, 'a'.repeat(128)).expect(401);
    expect(forged.body).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });

  it('stays pending through a Paystack outage and recovers on retry with the same key', async () => {
    paystack.failNext(503);

    const outage = await startPayment(
      { amount: 5_000, currency: 'USD' },
      'ps-outage',
    ).expect(503);
    expect(outage.body).toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' });

    const retry = (
      await startPayment(
        { amount: 5_000, currency: 'USD' },
        'ps-outage',
      ).expect(201)
    ).body as PaymentResponseDto;
    expect(retry.authorizationUrl).not.toBeNull();
  });

  it('marks the payment failed when Paystack rejects it', async () => {
    paystack.failNext(400);

    const response = await startPayment({
      amount: 5_000,
      currency: 'USD',
    }).expect(201);
    expect(response.body).toMatchObject({
      status: 'failed',
      failureCode: 'PROVIDER_REJECTED',
    });
  });

  it('refuses currencies Paystack cannot charge before creating anything', async () => {
    const response = await startPayment({
      amount: 500,
      currency: 'JPY',
    }).expect(422);

    expect(response.body).toMatchObject({
      code: 'CURRENCY_NOT_SUPPORTED_BY_PROVIDER',
    });
    expect(paystack.requests).toHaveLength(0);
    await expect(
      app.get(DataSource).query('SELECT 1 FROM payments'),
    ).resolves.toHaveLength(0);
  });
});
