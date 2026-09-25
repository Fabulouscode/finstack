import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { STRIPE_SIGNATURE_HEADER } from '../src/payment-providers/stripe/stripe.provider';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { FakeStripe } from './utils/fake-stripe';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

const SECRET_KEY = 'sk_test_e2estripe123';
const WEBHOOK_SECRET = 'whsec_e2estripesecret';

describe('Stripe provider (e2e, fake Stripe API)', () => {
  const originalEnv = process.env;
  let stripe: FakeStripe;
  let app: INestApplication<App>;
  let token: string;

  const authed = (method: 'get' | 'post', path: string): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const startPayment = async (key: string): Promise<PaymentResponseDto> =>
    expectStatus(
      await authed('post', '/v1/payments')
        .set('Idempotency-Key', key)
        .send({ amount: 2_500, currency: 'USD' }),
      201,
      'start payment',
    ).body as PaymentResponseDto;

  const deliver = (rawBody: Buffer, signature: string): request.Test =>
    request(app.getHttpServer())
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set(STRIPE_SIGNATURE_HEADER, signature)
      .send(rawBody.toString('utf8'));

  beforeEach(async () => {
    stripe = new FakeStripe(SECRET_KEY, WEBHOOK_SECRET);
    const baseUrl = await stripe.start();
    process.env = {
      ...originalEnv,
      AUTH_RATE_LIMIT_MAX: '50',
      PAYMENT_PROVIDERS: 'stripe,mock',
      DEFAULT_PAYMENT_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_BASE_URL: baseUrl,
      STRIPE_TIMEOUT_MS: '2000',
      STRIPE_SUCCESS_URL: 'https://app.example.com/paid',
      STRIPE_CANCEL_URL: 'https://app.example.com/cancelled',
    };
    app = await createTestApp();
    await resetDatabase(app.get(DataSource));
    token = (await registerUser(app, 'ada@example.com')).tokens.accessToken;
    expectStatus(
      await authed('post', '/v1/wallets').send({}),
      201,
      'open wallet',
    );
  });

  afterEach(async () => {
    await app.close();
    await stripe.stop();
    process.env = originalEnv;
  });

  it('pays through a Checkout Session and settles from the signed event', async () => {
    const payment = await startPayment('st-1');
    expect(payment).toMatchObject({ provider: 'stripe', status: 'pending' });
    expect(payment.providerReference).toMatch(/^cs_test_/);
    expect(payment.authorizationUrl).toMatch(
      /^https:\/\/checkout\.stripe\.test\//,
    );
    expect(stripe.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/checkout/sessions',
      idempotencyKey: `finstack-init-${payment.reference}`,
    });

    const { rawBody, signature } = stripe.complete(
      payment.providerReference ?? '',
      'paid',
    );
    await deliver(rawBody, signature).expect(200, {
      received: true,
      duplicate: false,
    });

    await eventually(async () => {
      const wallet = (await authed('get', '/v1/wallets/primary').expect(200))
        .body as WalletResponseDto;
      expect(wallet.balances.available).toBe(2_500);
    });
  });

  it('rejects a replayed (stale) webhook even with a valid signature', async () => {
    const payment = await startPayment('st-2');
    const { rawBody, signature } = stripe.complete(
      payment.providerReference ?? '',
      'paid',
      {
        signedSecondsAgo: 600,
      },
    );

    const response = await deliver(rawBody, signature).expect(401);
    expect(response.body).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });

  it('fails the payment when the Checkout Session expires', async () => {
    const payment = await startPayment('st-3');
    const { rawBody, signature } = stripe.complete(
      payment.providerReference ?? '',
      'expired',
    );

    await deliver(rawBody, signature).expect(200);

    await eventually(async () => {
      const current = (
        await authed('get', `/v1/payments/${payment.id}`).expect(200)
      ).body as PaymentResponseDto;
      expect(current).toMatchObject({
        status: 'failed',
        failureCode: 'PAYMENT_FAILED',
      });
    });
  });
});
