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
import {
  PayoutDestinationResponseDto,
  PayoutResponseDto,
} from '../src/payouts/dto/payout.dto';
import {
  ReconciliationItemResponseDto,
  ReconciliationItemsPageDto,
  ReconciliationRunResponseDto,
} from '../src/reconciliation/dto/reconciliation.dto';
import { ReconciliationTrigger } from '../src/reconciliation/reconciliation-run.entity';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

describe('Reconciliation (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let mock: MockPaymentProvider;
  let service: ReconciliationService;
  let user: AuthResponseDto;
  let admin: AuthResponseDto;
  let keys = 0;

  const as = (
    token: string,
    method: 'get' | 'post',
    path: string,
  ): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const deliver = async ({
    rawBody,
    signature,
  }: {
    rawBody: Buffer;
    signature: string;
  }): Promise<void> => {
    await request(app.getHttpServer())
      .post('/v1/webhooks/mock')
      .set('Content-Type', 'application/json')
      .set(MOCK_SIGNATURE_HEADER, signature)
      .send(rawBody.toString('utf8'))
      .expect(200);
  };

  const startPayment = async (amount: number): Promise<PaymentResponseDto> =>
    expectStatus(
      await as(user.tokens.accessToken, 'post', '/v1/payments')
        .set('Idempotency-Key', `pay-${++keys}`)
        .send({ amount, currency: 'USD' }),
      201,
      'payment',
    ).body as PaymentResponseDto;

  const paymentStatus = async (id: string): Promise<string> =>
    (
      (
        await as(user.tokens.accessToken, 'get', `/v1/payments/${id}`).expect(
          200,
        )
      ).body as PaymentResponseDto
    ).status;

  const paid = async (amount: number): Promise<PaymentResponseDto> => {
    const payment = await startPayment(amount);
    await deliver(
      mock.simulateOutcome(payment.providerReference ?? '', 'successful'),
    );
    await eventually(async () => {
      expect(await paymentStatus(payment.id)).toBe('successful');
    });
    return payment;
  };

  /** Around now, so everything created by the test is inside. */
  const aroundNow = (): { from: Date; to: Date } => ({
    from: new Date(Date.now() - 60 * 60 * 1000),
    to: new Date(Date.now() + 60 * 60 * 1000),
  });

  const reconcile = async (
    provider: string | null = 'mock',
  ): Promise<{
    run: ReconciliationRunResponseDto;
    items: ReconciliationItemResponseDto[];
  }> => {
    const created = await service.createRun({
      provider,
      range: aroundNow(),
      trigger: ReconciliationTrigger.Manual,
    });
    const run = await service.execute(created?.id ?? '');
    const page = expectStatus(
      await as(
        admin.tokens.accessToken,
        'get',
        `/v1/admin/reconciliation/items?runId=${run.id}`,
      ),
      200,
      'items',
    ).body as ReconciliationItemsPageDto;
    return {
      run: ReconciliationRunResponseDto.from(run),
      items: page.data,
    };
  };

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    mock = app.get(MockPaymentProvider);
    mock.setPayoutBehaviour('successful');
    service = app.get(ReconciliationService);
    await resetDatabase(dataSource);

    user = await registerUser(app, 'ada@example.com');
    expectStatus(
      await as(user.tokens.accessToken, 'post', '/v1/wallets').send({}),
      201,
      'wallet',
    );
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
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  it('finds nothing when FinStack and the provider agree', async () => {
    await paid(5_000);
    const pending = await startPayment(1_000); // unpaid: fine on both sides
    expect(pending.status).toBe('pending');

    const { run, items } = await reconcile();

    expect(run).toMatchObject({
      status: 'completed',
      summary: { paymentsChecked: 2, payoutsChecked: 0, issues: 0 },
    });
    expect(items).toEqual([]);
  });

  it('settles a payment whose webhook never arrived', async () => {
    const payment = await startPayment(5_000);
    mock.setPaymentStatus(payment.providerReference ?? '', 'successful');

    const { run, items } = await reconcile();

    expect(await paymentStatus(payment.id)).toBe('successful');
    expect(run.summary).toMatchObject({ issues: 0, autoResolved: 1 });
    expect(items).toEqual([
      expect.objectContaining({
        issue: 'late_settlement',
        status: 'auto_resolved',
        targetId: payment.id,
      }),
    ]);
  });

  it('flags money the provider collected that FinStack never recorded', async () => {
    const providerReference = mock.recordExternalPayment({
      amount: 2_500n,
      currency: 'USD',
    });

    const { items } = await reconcile();

    expect(items).toEqual([
      expect.objectContaining({
        kind: 'payment',
        issue: 'missing_in_finstack',
        status: 'open',
        reference: providerReference,
        provider: expect.objectContaining({ amount: '2500' }) as unknown,
      }),
    ]);
  });

  it('flags credits the provider does not back', async () => {
    const payment = await paid(5_000);
    mock.setPaymentStatus(payment.providerReference ?? '', 'failed');

    const { items } = await reconcile();

    expect(items).toEqual([
      expect.objectContaining({
        issue: 'credited_without_payment',
        targetId: payment.id,
        finstack: expect.objectContaining({ status: 'successful' }) as unknown,
        provider: expect.objectContaining({ status: 'failed' }) as unknown,
      }),
    ]);
  });

  it('settles payouts the provider completed without telling us', async () => {
    await paid(10_000);
    const destination = expectStatus(
      await as(user.tokens.accessToken, 'post', '/v1/payout-destinations').send(
        { currency: 'USD', bankCode: '058', accountNumber: '0123456789' },
      ),
      201,
      'destination',
    ).body as PayoutDestinationResponseDto;
    mock.setPayoutBehaviour('pending');
    const payout = expectStatus(
      await as(user.tokens.accessToken, 'post', '/v1/payouts')
        .set('Idempotency-Key', 'payout-1')
        .send({ destinationId: destination.id, amount: 4_000 }),
      201,
      'payout',
    ).body as PayoutResponseDto;
    expect(payout.status).toBe('processing');
    // The provider completes it; the webhook is lost.
    mock.simulatePayoutOutcome(payout.reference, 'successful');

    const { run, items } = await reconcile();

    expect(run.summary).toMatchObject({ payoutsChecked: 1, issues: 0 });
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'payout',
        issue: 'late_settlement',
        status: 'auto_resolved',
      }),
    ]);
    const after = (
      await as(
        user.tokens.accessToken,
        'get',
        `/v1/payouts/${payout.id}`,
      ).expect(200)
    ).body as PayoutResponseDto;
    expect(after.status).toBe('successful');
  });

  it('checks the ledger on its own', async () => {
    await paid(5_000);
    const { run, items } = await reconcile(null);
    expect(run).toMatchObject({ provider: null, status: 'completed' });
    expect(items).toEqual([]);
  });

  it('runs the daily schedule once per period', async () => {
    const now = new Date();
    const first = await service.runScheduled(now);
    expect(first.map((run) => run.provider)).toEqual([null, 'mock']);
    await expect(service.runScheduled(now)).resolves.toEqual([]);
  });

  describe('admin API', () => {
    it('runs in the background and lets admins resolve items', async () => {
      mock.recordExternalPayment({ amount: 700n, currency: 'USD' });
      // The period's end is exclusive; don't let it share the millisecond.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const started = expectStatus(
        await as(
          admin.tokens.accessToken,
          'post',
          '/v1/admin/reconciliation/runs',
        ).send({
          provider: 'mock',
          from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          to: new Date().toISOString(),
        }),
        202,
        'start',
      ).body as ReconciliationRunResponseDto;
      expect(started.status).toBe('running');

      await eventually(async () => {
        const run = (
          await as(
            admin.tokens.accessToken,
            'get',
            `/v1/admin/reconciliation/runs/${started.id}`,
          ).expect(200)
        ).body as ReconciliationRunResponseDto;
        expect(run).toMatchObject({
          status: 'completed',
          summary: { issues: 1 },
        });
      });

      const open = (
        await as(
          admin.tokens.accessToken,
          'get',
          '/v1/admin/reconciliation/items?status=open',
        ).expect(200)
      ).body as ReconciliationItemsPageDto;
      expect(open.data).toHaveLength(1);
      const itemId = open.data[0]?.id ?? '';

      const resolved = expectStatus(
        await as(
          admin.tokens.accessToken,
          'post',
          `/v1/admin/reconciliation/items/${itemId}/resolve`,
        ).send({ note: 'Refunded at the provider dashboard' }),
        200,
        'resolve',
      ).body as ReconciliationItemResponseDto;
      expect(resolved).toMatchObject({
        status: 'resolved',
        resolutionNote: 'Refunded at the provider dashboard',
      });

      const again = await as(
        admin.tokens.accessToken,
        'post',
        `/v1/admin/reconciliation/items/${itemId}/resolve`,
      ).send({ note: 'twice' });
      expect(again.status).toBe(409);

      const [entry] = await dataSource.query<{ action: string }[]>(
        `SELECT action FROM audit_logs WHERE target_id = $1`,
        [itemId],
      );
      expect(entry?.action).toBe('reconciliation_item.resolved');
    });

    it('validates the period and is admin-only', async () => {
      const future = await as(
        admin.tokens.accessToken,
        'post',
        '/v1/admin/reconciliation/runs',
      ).send({
        provider: 'mock',
        from: new Date().toISOString(),
        to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      expect(future.status).toBe(422);
      expect(future.body).toMatchObject({
        code: 'INVALID_RECONCILIATION_PERIOD',
      });

      await as(
        user.tokens.accessToken,
        'get',
        '/v1/admin/reconciliation/runs',
      ).expect(403);
    });
  });
});
