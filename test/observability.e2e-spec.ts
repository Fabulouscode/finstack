import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../src/payment-providers/mock/mock-payment.provider';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

describe('Observability (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let ada: AuthResponseDto;

  const boot = async (env: Record<string, string> = {}): Promise<void> => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50', ...env };
    app = await createTestApp();
    await resetDatabase(app.get(DataSource));
    ada = await registerUser(app, 'ada@example.com');
  };

  const metrics = async (): Promise<string> =>
    (await request(app.getHttpServer()).get('/metrics').expect(200)).text;

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  it('exposes HTTP metrics by route template, not by id', async () => {
    await boot();
    const wallet = expectStatus(
      await request(app.getHttpServer())
        .post('/v1/wallets')
        .set('Authorization', `Bearer ${ada.tokens.accessToken}`)
        .send({}),
      201,
      'wallet',
    ).body as WalletResponseDto;
    await request(app.getHttpServer())
      .get(`/v1/wallets/${wallet.id}`)
      .set('Authorization', `Bearer ${ada.tokens.accessToken}`)
      .expect(200);
    await request(app.getHttpServer()).get('/health/live').expect(200);

    const text = await metrics();
    expect(text).toMatch(
      /finstack_http_requests_total\{method="GET",route="\/v1\/wallets\/:walletId",status="200"\} 1/,
    );
    expect(text).toContain('finstack_http_request_duration_seconds_bucket');
    expect(text).not.toContain(wallet.id);
    expect(text).not.toContain('route="/health');
    // Queue depth, outbox backlog and process metrics, read at scrape time.
    expect(text).toMatch(
      /finstack_queue_jobs\{queue="webhooks",state="waiting"\} \d+/,
    );
    expect(text).toMatch(/finstack_outbox_pending_events \d+/);
    expect(text).toContain('finstack_process_cpu_seconds_total');
  });

  it('counts business events and provider webhooks', async () => {
    await boot();
    const auth = `Bearer ${ada.tokens.accessToken}`;
    await request(app.getHttpServer())
      .post('/v1/wallets')
      .set('Authorization', auth)
      .send({})
      .expect(201);
    const payment = expectStatus(
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set('Authorization', auth)
        .set('Idempotency-Key', 'pay-1')
        .send({ amount: 5_000, currency: 'USD' }),
      201,
      'payment',
    ).body as PaymentResponseDto;
    const { rawBody, signature } = app
      .get(MockPaymentProvider)
      .simulateOutcome(payment.providerReference ?? '', 'successful');
    await request(app.getHttpServer())
      .post('/v1/webhooks/mock')
      .set('Content-Type', 'application/json')
      .set(MOCK_SIGNATURE_HEADER, signature)
      .send(rawBody.toString('utf8'))
      .expect(200);

    await eventually(async () => {
      const text = await metrics();
      expect(text).toContain(
        'finstack_domain_events_total{type="payment.successful"} 1',
      );
      expect(text).toContain(
        'finstack_provider_webhooks_total{provider="mock",status="processed"} 1',
      );
    });
  });

  it('requires the token when one is set', async () => {
    await boot({ METRICS_TOKEN: 'scrape-secret-0123456789' });
    await request(app.getHttpServer()).get('/metrics').expect(401);
    await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', 'Bearer wrong-secret-0123456789')
      .expect(401);
    await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', 'Bearer scrape-secret-0123456789')
      .expect(200);
  });

  it('can be turned off', async () => {
    await boot({ METRICS_ENABLED: 'false' });
    await request(app.getHttpServer()).get('/metrics').expect(404);
  });
});
