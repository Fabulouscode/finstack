import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import { LogEmailTransport } from '../src/notifications/email-transport';
import { NotificationsService } from '../src/notifications/notifications.service';
import { OrganizationResponseDto } from '../src/organizations/dto/organization.dto';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../src/payment-providers/mock/mock-payment.provider';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import {
  PayoutDestinationResponseDto,
  PayoutResponseDto,
} from '../src/payouts/dto/payout.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

describe('Email notifications (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let mock: MockPaymentProvider;
  let inbox: LogEmailTransport;
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

  const emailsTo = (address: string): { subject: string; text: string }[] =>
    inbox.outbox.filter((email) => email.to === address);

  /** Pays `amount` into a wallet (user or organization) and waits for the credit. */
  const pay = async (
    token: string,
    path: string,
    amount: number,
    extra: object = {},
  ): Promise<PaymentResponseDto> => {
    const payment = expectStatus(
      await as(token, 'post', path)
        .set('Idempotency-Key', `pay-${++keys}`)
        .send({ amount, currency: 'USD', ...extra }),
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
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    mock = app.get(MockPaymentProvider);
    mock.setPayoutBehaviour('pending');
    inbox = app.get(LogEmailTransport);
    await resetDatabase(dataSource);

    ada = await registerUser(app, 'ada@example.com');
    expectStatus(
      await as(ada.tokens.accessToken, 'post', '/v1/wallets').send({}),
      201,
      'wallet',
    );
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  it('emails users about payments into their wallet', async () => {
    const payment = await pay(ada.tokens.accessToken, '/v1/payments', 5_000);

    await eventually(() => {
      expect(emailsTo('ada@example.com')).toEqual([
        expect.objectContaining({
          subject: 'Payment received: USD 50.00',
          text: expect.stringContaining(payment.reference) as unknown,
        }),
      ]);
      return Promise.resolve();
    });
    const [row] = await dataSource.query<
      { status: string; template: string }[]
    >('SELECT status, template FROM email_notifications');
    expect(row).toEqual({ status: 'sent', template: 'payment_received' });
  });

  it('emails both sides of a transfer', async () => {
    await pay(ada.tokens.accessToken, '/v1/payments', 5_000);
    const bob = await registerUser(app, 'bob@example.com');
    expectStatus(
      await as(bob.tokens.accessToken, 'post', '/v1/wallets').send({}),
      201,
      'bob wallet',
    );
    await eventually(async () => {
      expectStatus(
        await as(ada.tokens.accessToken, 'post', '/v1/transfers')
          .set('Idempotency-Key', 'transfer-1')
          .send({ recipientEmail: 'bob@example.com', amount: 1_250 }),
        201,
        'transfer',
      );
    });

    await eventually(() => {
      expect(emailsTo('bob@example.com').map((e) => e.subject)).toEqual([
        'You received USD 12.50',
      ]);
      expect(emailsTo('ada@example.com').map((e) => e.subject)).toContain(
        'You sent USD 12.50',
      );
      return Promise.resolve();
    });
  });

  it('never sends the same email twice for a redelivered event', async () => {
    await pay(ada.tokens.accessToken, '/v1/payments', 5_000);
    await eventually(() => {
      expect(emailsTo('ada@example.com')).toHaveLength(1);
      return Promise.resolve();
    });
    const [event] = await dataSource.query<
      { id: string; type: string; payload: object; created_at: Date }[]
    >(
      `SELECT id, type, payload, created_at FROM outbox_events WHERE type = 'payment.successful'`,
    );

    const again = await app.get(NotificationsService).handle({
      eventId: event?.id ?? '',
      type: event?.type ?? '',
      aggregateType: 'transaction',
      aggregateId: 'x',
      occurredAt: new Date().toISOString(),
      data: event?.payload ?? {},
    });
    expect(again).toBe(0);
    expect(emailsTo('ada@example.com')).toHaveLength(1);
  });

  it('retries when sending fails', async () => {
    jest
      .spyOn(inbox, 'send')
      .mockRejectedValueOnce(new Error('SMTP unavailable'));

    await pay(ada.tokens.accessToken, '/v1/payments', 5_000);

    await eventually(async () => {
      const [row] = await dataSource.query<
        { status: string; attempts: number; last_error: string | null }[]
      >('SELECT status, attempts, last_error FROM email_notifications');
      expect(row).toEqual({ status: 'sent', attempts: 2, last_error: null });
    });
  });

  it("emails an organization's owners and admins when a payout fails, and nothing for its payments", async () => {
    const owner = await registerUser(app, 'owner@example.com');
    const orgId = (
      expectStatus(
        await as(owner.tokens.accessToken, 'post', '/v1/organizations').send({
          name: 'Acme',
        }),
        201,
        'org',
      ).body as OrganizationResponseDto
    ).id;
    for (const [email, role] of [
      ['admin@example.com', 'admin'],
      ['member@example.com', 'member'],
    ] as const) {
      await registerUser(app, email);
      await as(
        owner.tokens.accessToken,
        'post',
        `/v1/organizations/${orgId}/members`,
      )
        .send({ email, role })
        .expect(201);
    }
    expectStatus(
      await as(
        owner.tokens.accessToken,
        'post',
        `/v1/organizations/${orgId}/wallets`,
      ).send({}),
      201,
      'org wallet',
    );
    await pay(
      owner.tokens.accessToken,
      `/v1/organizations/${orgId}/payments`,
      10_000,
      { customerEmail: 'customer@example.com' },
    );

    const destination = expectStatus(
      await as(
        owner.tokens.accessToken,
        'post',
        `/v1/organizations/${orgId}/payout-destinations`,
      ).send({ currency: 'USD', bankCode: '058', accountNumber: '0123456789' }),
      201,
      'destination',
    ).body as PayoutDestinationResponseDto;
    const payout = await eventually(
      async () =>
        expectStatus(
          await as(
            owner.tokens.accessToken,
            'post',
            `/v1/organizations/${orgId}/payouts`,
          )
            .set('Idempotency-Key', 'org-payout')
            .send({ destinationId: destination.id, amount: 4_000 }),
          201,
          'payout',
        ).body as PayoutResponseDto,
    );
    const { rawBody, signature } = mock.simulatePayoutOutcome(
      payout.reference,
      'failed',
    );
    await request(app.getHttpServer())
      .post('/v1/webhooks/mock')
      .set('Content-Type', 'application/json')
      .set(MOCK_SIGNATURE_HEADER, signature)
      .send(rawBody.toString('utf8'))
      .expect(200);

    await eventually(() => {
      for (const address of ['owner@example.com', 'admin@example.com']) {
        expect(emailsTo(address).map((e) => e.subject)).toEqual([
          'Withdrawal failed: USD 40.00',
        ]);
      }
      return Promise.resolve();
    });
    expect(emailsTo('member@example.com')).toEqual([]);
    expect(emailsTo('customer@example.com')).toEqual([]);
  });
});
