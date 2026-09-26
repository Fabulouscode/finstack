import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import { LimitUsageResponseDto } from '../src/limits/dto/limit.dto';
import { LedgerService } from '../src/ledger/ledger.service';
import { LogEmailTransport } from '../src/notifications/email-transport';
import { OrganizationResponseDto } from '../src/organizations/dto/organization.dto';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../src/payment-providers/mock/mock-payment.provider';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import { PayoutDestinationResponseDto } from '../src/payouts/dto/payout.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

describe('Risk controls (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let mock: MockPaymentProvider;
  let admin: AuthResponseDto;
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

  const setLimit = async (rule: object): Promise<void> => {
    expectStatus(
      await as(admin.tokens.accessToken, 'post', '/v1/admin/limit-rules').send(
        rule,
      ),
      201,
      'set limit',
    );
  };

  const fund = async (amount: number): Promise<void> => {
    const payment = expectStatus(
      await asAda('post', '/v1/payments')
        .set('Idempotency-Key', `fund-${++keys}`)
        .send({ amount, currency: 'USD' }),
      201,
      'fund',
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
    await eventually(async () => {
      const current = (
        await asAda('get', `/v1/payments/${payment.id}`).expect(200)
      ).body as PaymentResponseDto;
      expect(current.status).toBe('successful');
    });
  };

  const transfer = (amount: number): request.Test =>
    asAda('post', '/v1/transfers')
      .set('Idempotency-Key', `transfer-${++keys}`)
      .send({ recipientEmail: 'bob@example.com', amount });

  const boot = async (env: Record<string, string> = {}): Promise<void> => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '100', ...env };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    mock = app.get(MockPaymentProvider);
    mock.setPayoutBehaviour('pending');
    await resetDatabase(dataSource);

    await registerUser(app, 'admin@example.com');
    await dataSource.query(
      `UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'`,
    );
    admin = expectStatus(
      await request(app.getHttpServer()).post('/v1/auth/login').send({
        email: 'admin@example.com',
        password: 'correct-horse-battery-staple',
      }),
      200,
      'admin login',
    ).body as AuthResponseDto;
    ada = await registerUser(app, 'ada@example.com');
    await asAda('post', '/v1/wallets').send({}).expect(201);
    const bob = await registerUser(app, 'bob@example.com');
    await as(bob.tokens.accessToken, 'post', '/v1/wallets')
      .send({})
      .expect(201);
  };

  afterEach(async () => {
    const ledger = app.get(LedgerService);
    await expect(ledger.findBalanceDiscrepancies()).resolves.toEqual([]);
    await app.close();
    process.env = originalEnv;
  });

  describe('velocity limits', () => {
    beforeEach(() => boot());

    it('caps a single transaction', async () => {
      await fund(10_000);
      await setLimit({
        operation: 'transfer',
        currency: 'USD',
        maxPerTransaction: 2_000,
      });

      const refused = await transfer(2_500);
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'LIMIT_EXCEEDED',
        detail: 'The transfer limit is USD 20.00 per transaction',
      });
      await transfer(2_000).expect(201);
    });

    it('caps the rolling 24-hour amount and count, and says what is left', async () => {
      await fund(10_000);
      await setLimit({
        operation: 'transfer',
        currency: 'USD',
        maxDailyAmount: 3_000,
        maxDailyCount: 3,
      });

      await transfer(2_000).expect(201);
      const over = await transfer(1_500);
      expect(over.body).toMatchObject({
        code: 'LIMIT_EXCEEDED',
        detail: expect.stringContaining('(USD 10.00 left)') as unknown,
      });
      await transfer(500).expect(201);
      await transfer(100).expect(201);
      const count = await transfer(100);
      expect(count.body).toMatchObject({
        detail: 'The transfer limit is 3 per 24 hours',
      });

      const [usage] = (await asAda('get', '/v1/limits').expect(200))
        .body as LimitUsageResponseDto[];
      expect(usage).toMatchObject({
        operation: 'transfer',
        daily: {
          maxAmount: 3_000,
          usedAmount: 2_600,
          remainingAmount: 400,
          maxCount: 3,
          usedCount: 3,
        },
      });
    });

    it('holds under concurrency: parallel requests cannot exceed the limit together', async () => {
      await fund(10_000);
      await setLimit({
        operation: 'transfer',
        currency: 'USD',
        maxDailyAmount: 3_000,
      });

      const results = await Promise.all(
        Array.from({ length: 6 }, () => transfer(1_000)),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 201, 201, 422, 422, 422]);
    });

    it('does not count failed payouts', async () => {
      await fund(10_000);
      await setLimit({
        operation: 'payout',
        currency: 'USD',
        maxDailyAmount: 5_000,
      });
      const destination = (
        await asAda('post', '/v1/payout-destinations')
          .send({
            currency: 'USD',
            bankCode: '058',
            accountNumber: '0123456789',
          })
          .expect(201)
      ).body as PayoutDestinationResponseDto;
      const payout = (amount: number): request.Test =>
        asAda('post', '/v1/payouts')
          .set('Idempotency-Key', `payout-${++keys}`)
          .send({ destinationId: destination.id, amount });

      mock.setPayoutBehaviour('rejected');
      const failed = (await payout(4_000).expect(201)).body as {
        status: string;
      };
      expect(failed.status).toBe('failed');

      mock.setPayoutBehaviour('pending');
      await payout(4_000).expect(201);
      const over = await payout(2_000);
      expect(over.body).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    });

    it('lets organizations have their own limits', async () => {
      await setLimit({
        operation: 'payment',
        currency: 'USD',
        maxPerTransaction: 1_000,
      });
      const orgId = (
        expectStatus(
          await asAda('post', '/v1/organizations').send({ name: 'Acme' }),
          201,
          'org',
        ).body as OrganizationResponseDto
      ).id;
      await asAda('post', `/v1/organizations/${orgId}/wallets`)
        .send({})
        .expect(201);
      await setLimit({
        operation: 'payment',
        currency: 'USD',
        organizationId: orgId,
        maxPerTransaction: 50_000,
      });

      await asAda('post', `/v1/organizations/${orgId}/payments`)
        .set('Idempotency-Key', 'org-pay')
        .send({
          amount: 30_000,
          currency: 'USD',
          customerEmail: 'c@example.com',
        })
        .expect(201);
      const personal = await asAda('post', '/v1/payments')
        .set('Idempotency-Key', 'user-pay')
        .send({ amount: 30_000, currency: 'USD' });
      expect(personal.body).toMatchObject({ code: 'LIMIT_EXCEEDED' });

      const orgLimits = (
        await asAda('get', `/v1/organizations/${orgId}/limits`).expect(200)
      ).body as LimitUsageResponseDto[];
      expect(orgLimits).toEqual([
        expect.objectContaining({
          operation: 'payment',
          maxPerTransaction: 50_000,
        }),
      ]);
    });
  });

  describe('new payout accounts', () => {
    it('cool off before they can receive money, and the owner is emailed', async () => {
      await boot({ PAYOUT_DESTINATION_COOLDOWN_MINUTES: '60' });
      await fund(10_000);

      const destination = (
        await asAda('post', '/v1/payout-destinations')
          .send({
            currency: 'USD',
            bankCode: '058',
            accountNumber: '0123456789',
          })
          .expect(201)
      ).body as PayoutDestinationResponseDto;
      const unlocksIn =
        new Date(destination.payoutsAvailableAt).getTime() - Date.now();
      expect(unlocksIn).toBeGreaterThan(59 * 60_000);

      const refused = await asAda('post', '/v1/payouts')
        .set('Idempotency-Key', 'too-soon')
        .send({ destinationId: destination.id, amount: 1_000 });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'PAYOUT_DESTINATION_COOLING_OFF',
      });

      await eventually(() => {
        const alert = app
          .get(LogEmailTransport)
          .outbox.find(
            (email) =>
              email.to === 'ada@example.com' &&
              email.subject.includes('bank account'),
          );
        expect(alert?.text).toContain('If you did not add it');
        return Promise.resolve();
      });

      // Once the period has passed, payouts go through.
      await dataSource.query(
        `UPDATE payout_destinations SET payouts_available_at = now() - interval '1 second'`,
      );
      await asAda('post', '/v1/payouts')
        .set('Idempotency-Key', 'after-cooling-off')
        .send({ destinationId: destination.id, amount: 1_000 })
        .expect(201);
    });
  });
});
