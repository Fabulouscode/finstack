import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import { OrganizationResponseDto } from '../src/organizations/dto/organization.dto';
import {
  WebhookDeliveriesPageDto,
  WebhookDeliveryResponseDto,
  WebhookEndpointResponseDto,
  WebhookEndpointWithSecretResponseDto,
} from '../src/outbound-webhooks/dto/webhook-endpoint.dto';
import { verifySignatureHeader } from '../src/outbound-webhooks/webhook-signature';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../src/payment-providers/mock/mock-payment.provider';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';
import { WebhookReceiver } from './utils/webhook-receiver';

describe('Outbound webhooks (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let mock: MockPaymentProvider;
  let receiver: WebhookReceiver;
  let owner: AuthResponseDto;
  let orgId: string;
  let keys = 0;

  const as = (
    token: string,
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
  ): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const asOwner = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
  ): request.Test => as(owner.tokens.accessToken, method, path);

  const endpointsPath = (suffix = ''): string =>
    `/v1/organizations/${orgId}/webhook-endpoints${suffix}`;

  const createEndpoint = async (
    eventTypes: string[] = ['*'],
    url = receiver.url,
  ): Promise<WebhookEndpointWithSecretResponseDto> =>
    expectStatus(
      await asOwner('post', endpointsPath()).send({ url, eventTypes }),
      201,
      'create endpoint',
    ).body as WebhookEndpointWithSecretResponseDto;

  const deliveries = async (
    endpointId: string,
  ): Promise<WebhookDeliveryResponseDto[]> =>
    (
      (
        await asOwner('get', endpointsPath(`/${endpointId}/deliveries`)).expect(
          200,
        )
      ).body as WebhookDeliveriesPageDto
    ).data;

  /** An organization payment, paid, which emits payment.successful. */
  const orgPaymentSucceeds = async (): Promise<PaymentResponseDto> => {
    const payment = expectStatus(
      await asOwner('post', `/v1/organizations/${orgId}/payments`)
        .set('Idempotency-Key', `pay-${++keys}`)
        .send({
          amount: 5_000,
          currency: 'USD',
          customerEmail: 'c@example.com',
        }),
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
    return payment;
  };

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      AUTH_RATE_LIMIT_MAX: '50',
      OUTBOUND_WEBHOOK_MAX_ATTEMPTS: '3',
      OUTBOUND_WEBHOOK_BACKOFF_MS: '20',
      OUTBOUND_WEBHOOK_DISABLE_AFTER_FAILURES: '2',
    };
    receiver = new WebhookReceiver();
    await receiver.start();
    app = await createTestApp();
    dataSource = app.get(DataSource);
    mock = app.get(MockPaymentProvider);
    await resetDatabase(dataSource);

    owner = await registerUser(app, 'owner@example.com');
    orgId = (
      expectStatus(
        await asOwner('post', '/v1/organizations').send({ name: 'Acme' }),
        201,
        'org',
      ).body as OrganizationResponseDto
    ).id;
    expectStatus(
      await asOwner('post', `/v1/organizations/${orgId}/wallets`).send({}),
      201,
      'wallet',
    );
  });

  afterEach(async () => {
    await app.close();
    await receiver.stop();
    process.env = originalEnv;
  });

  it('sends signed events the organization subscribed to', async () => {
    const endpoint = await createEndpoint(['payment.successful']);
    expect(endpoint.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);

    const payment = await orgPaymentSucceeds();

    await eventually(() => {
      expect(receiver.received).toHaveLength(1);
    });
    const [received] = receiver.received;
    const [event] = receiver.events();
    expect(event).toMatchObject({
      type: 'payment.successful',
      data: { paymentId: payment.id, organizationId: orgId },
    });
    expect(received?.headers['finstack-event-id']).toBe(event?.id);
    expect(
      verifySignatureHeader(
        String(received?.headers['finstack-signature']),
        endpoint.secret,
        received?.body ?? '',
      ),
    ).toBe(true);

    await eventually(async () => {
      expect(await deliveries(endpoint.id)).toEqual([
        expect.objectContaining({ status: 'succeeded', attempts: 1 }),
      ]);
    });
  });

  it('only sends subscribed event types, and never user-owned events', async () => {
    await createEndpoint(['payout.failed']);
    await orgPaymentSucceeds();

    // A personal payment of the same person: not the organization's.
    expectStatus(
      await asOwner('post', '/v1/wallets').send({}),
      201,
      'personal wallet',
    );
    const personal = expectStatus(
      await asOwner('post', '/v1/payments')
        .set('Idempotency-Key', 'personal')
        .send({ amount: 100, currency: 'USD' }),
      201,
      'personal payment',
    ).body as PaymentResponseDto;
    const { rawBody, signature } = mock.simulateOutcome(
      personal.providerReference ?? '',
      'successful',
    );
    await request(app.getHttpServer())
      .post('/v1/webhooks/mock')
      .set('Content-Type', 'application/json')
      .set(MOCK_SIGNATURE_HEADER, signature)
      .send(rawBody.toString('utf8'))
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(receiver.received).toHaveLength(0);
  });

  it('retries failed deliveries with backoff', async () => {
    const endpoint = await createEndpoint();
    receiver.respondWith(500, 503);

    await asOwner('post', endpointsPath(`/${endpoint.id}/test`)).expect(202);

    await eventually(async () => {
      expect(await deliveries(endpoint.id)).toEqual([
        expect.objectContaining({
          eventType: 'webhook.test',
          status: 'succeeded',
          attempts: 3,
          lastResponseStatus: 200,
        }),
      ]);
    });
    // The same event each time.
    expect(new Set(receiver.events().map((e) => e.id)).size).toBe(1);
  });

  it('disables an endpoint that keeps failing, and recovers after a fix', async () => {
    const endpoint = await createEndpoint();
    receiver.respondWith(...Array<number>(6).fill(500));

    await asOwner('post', endpointsPath(`/${endpoint.id}/test`)).expect(202);
    await asOwner('post', endpointsPath(`/${endpoint.id}/test`)).expect(202);

    await eventually(async () => {
      const current = (
        await asOwner('get', endpointsPath(`/${endpoint.id}`)).expect(200)
      ).body as WebhookEndpointResponseDto;
      expect(current).toMatchObject({
        enabled: false,
        disabledReason: expect.stringContaining(
          '2 failed deliveries',
        ) as unknown,
      });
    });
    const failed = await deliveries(endpoint.id);
    expect(failed.map((d) => d.status)).toEqual(['failed', 'failed']);

    // The receiver is fixed: re-enable and redeliver.
    await asOwner('patch', endpointsPath(`/${endpoint.id}`))
      .send({ enabled: true })
      .expect(200);
    await asOwner(
      'post',
      endpointsPath(`/${endpoint.id}/deliveries/${failed[0]?.id}/redeliver`),
    ).expect(202);
    await eventually(async () => {
      const after = await deliveries(endpoint.id);
      expect(after.find((d) => d.id === failed[0]?.id)?.status).toBe(
        'succeeded',
      );
    });
  });

  it('signs with both secrets during a rotation', async () => {
    const endpoint = await createEndpoint();
    const rotated = expectStatus(
      await asOwner(
        'post',
        endpointsPath(`/${endpoint.id}/rotate-secret`),
      ).send({
        graceHours: 1,
      }),
      200,
      'rotate',
    ).body as WebhookEndpointWithSecretResponseDto;
    expect(rotated.secret).not.toBe(endpoint.secret);
    expect(rotated.previousSecretExpiresAt).not.toBeNull();

    await asOwner('post', endpointsPath(`/${endpoint.id}/test`)).expect(202);
    await eventually(() => {
      expect(receiver.received).toHaveLength(1);
    });
    const [received] = receiver.received;
    const header = String(received?.headers['finstack-signature']);
    for (const secret of [endpoint.secret, rotated.secret]) {
      expect(verifySignatureHeader(header, secret, received?.body ?? '')).toBe(
        true,
      );
    }
  });

  it('stores the signing secret encrypted and shows it only once', async () => {
    const endpoint = await createEndpoint();
    const [row] = await dataSource.query<object[]>(
      'SELECT * FROM webhook_endpoints',
    );
    expect(JSON.stringify(row)).not.toContain(endpoint.secret);

    const listed = (await asOwner('get', endpointsPath()).expect(200))
      .body as object[];
    expect(JSON.stringify(listed)).not.toContain(endpoint.secret);
  });

  it('refuses private addresses where they are not allowed', async () => {
    await app.close();
    process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_URLS = 'false';
    app = await createTestApp();

    const refused = await asOwner('post', endpointsPath()).send({
      url: 'http://169.254.169.254/latest/meta-data',
      eventTypes: ['*'],
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'WEBHOOK_URL_NOT_ALLOWED' });
  });

  it('needs webhooks:manage and stays within the organization', async () => {
    const endpoint = await createEndpoint();
    const member = await registerUser(app, 'bola@example.com');
    await asOwner('post', `/v1/organizations/${orgId}/members`)
      .send({ email: 'bola@example.com', role: 'member' })
      .expect(201);
    await as(member.tokens.accessToken, 'get', endpointsPath()).expect(403);

    const otherOrg = (
      (
        await asOwner('post', '/v1/organizations')
          .send({ name: 'Other' })
          .expect(201)
      ).body as OrganizationResponseDto
    ).id;
    await asOwner(
      'get',
      `/v1/organizations/${otherOrg}/webhook-endpoints/${endpoint.id}`,
    ).expect(404);

    const [entry] = await dataSource.query<{ action: string }[]>(
      `SELECT action FROM audit_logs WHERE target_id = $1`,
      [endpoint.id],
    );
    expect(entry?.action).toBe('webhook_endpoint.created');
  });
});
