import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import { AdminRateProvider } from '../src/fx/admin-rate.provider';
import { LedgerService } from '../src/ledger/ledger.service';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../src/payment-providers/mock/mock-payment.provider';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import { SettlementReleaseService } from '../src/payments/settlement-release.service';
import { RefundResponseDto } from '../src/refunds/dto/refund.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

const HOLD_SECONDS = 3600;

describe('Settlement holds (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let mock: MockPaymentProvider;
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

  const balances = async (): Promise<WalletResponseDto['balances']> =>
    (
      (
        await as(user.tokens.accessToken, 'get', '/v1/wallets/primary').expect(
          200,
        )
      ).body as WalletResponseDto
    ).balances;

  const getPayment = async (id: string): Promise<PaymentResponseDto> =>
    (await as(user.tokens.accessToken, 'get', `/v1/payments/${id}`).expect(200))
      .body as PaymentResponseDto;

  /** A successful payment, credited (under the hold) by the webhook worker. */
  const paid = async (
    amount: number,
    currency = 'USD',
  ): Promise<PaymentResponseDto> => {
    const payment = expectStatus(
      await as(user.tokens.accessToken, 'post', '/v1/payments')
        .set('Idempotency-Key', `pay-${++keys}`)
        .send({ amount, currency }),
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
    return eventually(async () => {
      const current = await getPayment(payment.id);
      expect(current.status).toBe('successful');
      return current;
    });
  };

  /** Pretends the hold period has passed. */
  const endHolds = (): Promise<unknown> =>
    dataSource.query(
      `UPDATE payments SET funds_available_at = now() - interval '1 second' WHERE pending_amount > 0`,
    );

  const refund = (paymentId: string, body: object = {}): request.Test =>
    as(
      admin.tokens.accessToken,
      'post',
      `/v1/admin/payments/${paymentId}/refunds`,
    )
      .set('Idempotency-Key', `refund-${++keys}`)
      .send({ reason: 'Customer request', ...body });

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      AUTH_RATE_LIMIT_MAX: '50',
      PAYMENT_SETTLEMENT_DELAY_SECONDS: String(HOLD_SECONDS),
    };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    mock = app.get(MockPaymentProvider);
    mock.setRefundBehaviour('successful');
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
    const ledger = app.get(LedgerService);
    await expect(ledger.findBalanceDiscrepancies()).resolves.toEqual([]);
    for (const currency of ['USD', 'NGN']) {
      const trial = await ledger.trialBalance(currency);
      expect(trial.debit).toBe(trial.credit);
    }
    await app.close();
    process.env = originalEnv;
  });

  it('credits payments to the pending balance until the hold ends', async () => {
    const before = Date.now();
    const payment = await paid(5_000);

    expect(payment.heldAmount).toBe(5_000);
    const availableAt = new Date(payment.fundsAvailableAt ?? 0).getTime();
    expect(availableAt).toBeGreaterThanOrEqual(before + HOLD_SECONDS * 1000);
    expect(await balances()).toEqual({
      available: 0,
      pending: 5_000,
      reserved: 0,
    });

    // Held money can't be spent yet.
    await registerUser(app, 'bob@example.com');
    const transfer = await as(user.tokens.accessToken, 'post', '/v1/transfers')
      .set('Idempotency-Key', 'early-transfer')
      .send({ recipientEmail: 'bob@example.com', amount: 1_000 });
    expect(transfer.status).toBe(422);

    // Not due yet: nothing is released.
    const release = app.get(SettlementReleaseService);
    await expect(release.releaseDue()).resolves.toBe(0);

    await endHolds();
    await expect(release.releaseDue()).resolves.toBe(1);
    await expect(release.releaseDue()).resolves.toBe(0);
    expect(await balances()).toEqual({
      available: 5_000,
      pending: 0,
      reserved: 0,
    });
    expect((await getPayment(payment.id)).heldAmount).toBe(0);

    const events = await dataSource.query<{ type: string }[]>(
      `SELECT type FROM outbox_events WHERE type = 'payment.funds_available'`,
    );
    expect(events).toHaveLength(1);
  });

  it('holds converted payments in the wallet currency', async () => {
    await app
      .get(AdminRateProvider)
      .setRate({ base: 'USD', quote: 'NGN', rate: '1550', userId: null });
    const payment = await paid(1_550_000, 'NGN');

    const credited = payment.conversion?.amount ?? 0;
    expect(credited).toBeGreaterThan(0);
    expect(payment.heldAmount).toBe(credited);
    expect(await balances()).toMatchObject({ available: 0, pending: credited });

    await endHolds();
    await app.get(SettlementReleaseService).releaseDue();
    expect(await balances()).toMatchObject({ available: credited, pending: 0 });
  });

  it('lets admins end a hold early, and audits it', async () => {
    const payment = await paid(5_000);

    const released = expectStatus(
      await as(
        admin.tokens.accessToken,
        'post',
        `/v1/admin/payments/${payment.id}/release`,
      ),
      200,
      'release',
    ).body as PaymentResponseDto;
    expect(released.heldAmount).toBe(0);
    expect(
      new Date(released.fundsAvailableAt ?? 0).getTime(),
    ).toBeLessThanOrEqual(Date.now());
    expect((await balances()).available).toBe(5_000);

    const [entry] = await dataSource.query<{ action: string }[]>(
      `SELECT action FROM audit_logs WHERE target_id = $1`,
      [payment.id],
    );
    expect(entry?.action).toBe('payment.released_early');

    await as(
      user.tokens.accessToken,
      'post',
      `/v1/admin/payments/${payment.id}/release`,
    ).expect(403);
  });

  it('refunds a held payment out of its pending credit', async () => {
    const payment = await paid(5_000);

    const created = expectStatus(await refund(payment.id), 201, 'refund')
      .body as RefundResponseDto;
    expect(created.status).toBe('successful');
    expect(await balances()).toEqual({ available: 0, pending: 0, reserved: 0 });

    // Nothing is left to release.
    await endHolds();
    await expect(app.get(SettlementReleaseService).releaseDue()).resolves.toBe(
      0,
    );
    expect(await balances()).toEqual({ available: 0, pending: 0, reserved: 0 });
  });

  it('returns a failed refund to pending while the hold lasts', async () => {
    const payment = await paid(5_000);
    mock.setRefundBehaviour('rejected');

    const created = expectStatus(
      await refund(payment.id, { amount: 2_000 }),
      201,
      'refund',
    ).body as RefundResponseDto;
    expect(created.status).toBe('failed');
    expect(await balances()).toEqual({
      available: 0,
      pending: 5_000,
      reserved: 0,
    });
    expect((await getPayment(payment.id)).heldAmount).toBe(5_000);

    await endHolds();
    await app.get(SettlementReleaseService).releaseDue();
    expect((await balances()).available).toBe(5_000);
  });

  it('holds a partial refund from pending and keeps the rest held', async () => {
    const payment = await paid(5_000);
    mock.setRefundBehaviour('pending');

    expectStatus(await refund(payment.id, { amount: 2_000 }), 201, 'refund');
    expect(await balances()).toEqual({
      available: 0,
      pending: 3_000,
      reserved: 2_000,
    });
    expect((await getPayment(payment.id)).heldAmount).toBe(3_000);

    await endHolds();
    await app.get(SettlementReleaseService).releaseDue();
    expect(await balances()).toEqual({
      available: 3_000,
      pending: 0,
      reserved: 2_000,
    });
  });
});
