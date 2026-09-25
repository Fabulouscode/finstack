import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AdminRateProvider } from '../src/fx/admin-rate.provider';
import { LedgerAccount } from '../src/ledger/ledger-account.entity';
import { LedgerService } from '../src/ledger/ledger.service';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../src/payment-providers/mock/mock-payment.provider';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import { RefundResponseDto } from '../src/refunds/dto/refund.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { WalletsService } from '../src/wallets/wallets.service';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

describe('Refunds (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let mock: MockPaymentProvider;
  let userToken: string;
  let adminToken: string;
  let keys = 0;

  const as = (
    token: string,
    method: 'get' | 'post',
    path: string,
  ): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const deliver = ({
    rawBody,
    signature,
  }: {
    rawBody: Buffer;
    signature: string;
  }): request.Test =>
    request(app.getHttpServer())
      .post('/v1/webhooks/mock')
      .set('Content-Type', 'application/json')
      .set(MOCK_SIGNATURE_HEADER, signature)
      .send(rawBody.toString('utf8'));

  /** A settled payment into the user's USD wallet. */
  const paidPayment = async (
    amount: number,
    currency: string,
  ): Promise<PaymentResponseDto> => {
    const payment = expectStatus(
      await as(userToken, 'post', '/v1/payments')
        .set('Idempotency-Key', `pay-${++keys}`)
        .send({ amount, currency }),
      201,
      'start payment',
    ).body as PaymentResponseDto;
    await deliver(
      mock.simulateOutcome(payment.providerReference ?? '', 'successful'),
    ).expect(200);
    await eventually(async () => {
      const current = (
        await as(userToken, 'get', `/v1/payments/${payment.id}`).expect(200)
      ).body as PaymentResponseDto;
      expect(current.status).toBe('successful');
    });
    return payment;
  };

  const refund = (
    paymentId: string,
    body: object,
    key = `rf-${++keys}`,
  ): request.Test =>
    as(adminToken, 'post', `/v1/admin/payments/${paymentId}/refunds`)
      .set('Idempotency-Key', key)
      .send({ reason: 'Customer request', ...body });

  const wallet = async (): Promise<WalletResponseDto['balances']> =>
    (
      (await as(userToken, 'get', '/v1/wallets/primary').expect(200))
        .body as WalletResponseDto
    ).balances;

  const systemBalance = async (code: string): Promise<bigint> =>
    (await dataSource.manager.findOneBy(LedgerAccount, { code }))?.balance ??
    0n;

  const paymentStatus = async (payment: PaymentResponseDto): Promise<string> =>
    (
      (await as(userToken, 'get', `/v1/payments/${payment.id}`).expect(200))
        .body as PaymentResponseDto
    ).status;

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    mock = app.get(MockPaymentProvider);
    await resetDatabase(dataSource);
    await app
      .get(AdminRateProvider)
      .setRate({ base: 'USD', quote: 'NGN', rate: '1550', userId: null });

    userToken = (await registerUser(app, 'ada@example.com')).tokens.accessToken;
    expectStatus(
      await as(userToken, 'post', '/v1/wallets').send({}),
      201,
      'open wallet',
    );
    await registerUser(app, 'admin@example.com');
    await dataSource.query(
      `UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'`,
    );
    adminToken = (
      expectStatus(
        await request(app.getHttpServer()).post('/v1/auth/login').send({
          email: 'admin@example.com',
          password: 'correct-horse-battery-staple',
        }),
        200,
        'admin login',
      ).body as { tokens: { accessToken: string } }
    ).tokens.accessToken;
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

  it('refunds a payment in full and marks it reversed', async () => {
    const payment = await paidPayment(5_000, 'USD');

    const created = (await refund(payment.id, {}).expect(201))
      .body as RefundResponseDto;

    expect(created).toMatchObject({
      status: 'successful',
      amount: 5_000,
      currency: 'USD',
      walletDebit: { amount: 5_000, currency: 'USD' },
      provider: 'mock',
    });
    await expect(wallet()).resolves.toEqual({
      available: 0,
      pending: 0,
      reserved: 0,
    });
    await expect(paymentStatus(payment)).resolves.toBe('reversed');
  });

  it('allows partial refunds up to the payment amount, never beyond', async () => {
    const payment = await paidPayment(5_000, 'USD');

    await refund(payment.id, { amount: 2_000 }).expect(201);
    const beyond = await refund(payment.id, { amount: 3_001 }).expect(422);
    expect(beyond.body).toMatchObject({ code: 'REFUND_EXCEEDS_REMAINING' });

    await refund(payment.id, { amount: 3_000 }).expect(201);
    const again = await refund(payment.id, { amount: 1 }).expect(422);
    expect(again.body).toMatchObject({ code: 'PAYMENT_ALREADY_REFUNDED' });

    await expect(wallet()).resolves.toMatchObject({ available: 0 });
    await expect(paymentStatus(payment)).resolves.toBe('reversed');
  });

  it('reverses an FX payment at the original rate, margin included', async () => {
    const payment = await paidPayment(1_550_000, 'NGN'); // $9.90 credited
    await expect(wallet()).resolves.toMatchObject({ available: 990 });

    const created = (await refund(payment.id, {}).expect(201))
      .body as RefundResponseDto;

    expect(created).toMatchObject({
      amount: 1_550_000,
      currency: 'NGN',
      walletDebit: { amount: 990, currency: 'USD' },
    });
    await expect(wallet()).resolves.toMatchObject({
      available: 0,
      reserved: 0,
    });
    // The conversion is fully unwound: no FX exposure or revenue left.
    await expect(systemBalance('system:fx-revenue:USD')).resolves.toBe(0n);
    await expect(systemBalance('system:fx-position:USD')).resolves.toBe(0n);
    await expect(systemBalance('system:fx-position:NGN')).resolves.toBe(0n);
    await expect(systemBalance('system:external-clearing:NGN')).resolves.toBe(
      0n,
    );
  });

  it('sums partial FX refunds exactly to the original amounts', async () => {
    const payment = await paidPayment(1_550_000, 'NGN');

    for (const amount of [10_000, 333_333, 1_206_667]) {
      await refund(payment.id, { amount }).expect(201);
    }

    await expect(wallet()).resolves.toMatchObject({ available: 0 });
    await expect(systemBalance('system:fx-revenue:USD')).resolves.toBe(0n);
  });

  it('refuses a refund the wallet can no longer cover, without side effects', async () => {
    const payment = await paidPayment(5_000, 'USD');
    const [walletRow] = await dataSource.query<{ id: string }[]>(
      'SELECT id FROM wallets',
    );
    await app.get(WalletsService).withdraw(walletRow?.id ?? '', {
      amount: 4_000n,
      reference: 'spent',
      description: 'Spent elsewhere',
    });

    const response = await refund(payment.id, {}).expect(422);

    expect(response.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await expect(
      dataSource.query('SELECT 1 FROM refunds'),
    ).resolves.toHaveLength(0);
    await expect(wallet()).resolves.toMatchObject({
      available: 1_000,
      reserved: 0,
    });
  });

  it('releases the hold when the provider rejects the refund', async () => {
    const payment = await paidPayment(5_000, 'USD');
    mock.setRefundBehaviour('rejected');

    const created = (await refund(payment.id, {}).expect(201))
      .body as RefundResponseDto;

    expect(created).toMatchObject({
      status: 'failed',
      failureCode: 'PROVIDER_REJECTED',
    });
    await expect(wallet()).resolves.toMatchObject({
      available: 5_000,
      reserved: 0,
    });
    await expect(paymentStatus(payment)).resolves.toBe('successful');
  });

  it('holds funds while pending, then settles from the signed refund webhook', async () => {
    const payment = await paidPayment(5_000, 'USD');
    mock.setRefundBehaviour('pending');

    const created = (await refund(payment.id, {}).expect(201))
      .body as RefundResponseDto;
    expect(created.status).toBe('processing');
    await expect(wallet()).resolves.toMatchObject({
      available: 0,
      reserved: 5_000,
    });

    await deliver(
      mock.simulateRefundOutcome(
        created.providerRefundReference ?? '',
        'successful',
      ),
    ).expect(200);

    await eventually(async () => {
      const current = (
        await as(adminToken, 'get', `/v1/admin/refunds/${created.id}`).expect(
          200,
        )
      ).body as RefundResponseDto;
      expect(current.status).toBe('successful');
    });
    await expect(wallet()).resolves.toMatchObject({
      available: 0,
      reserved: 0,
    });
  });

  it('returns the funds when a pending refund fails at the provider', async () => {
    const payment = await paidPayment(5_000, 'USD');
    mock.setRefundBehaviour('pending');
    const created = (await refund(payment.id, {}).expect(201))
      .body as RefundResponseDto;

    await deliver(
      mock.simulateRefundOutcome(
        created.providerRefundReference ?? '',
        'failed',
      ),
    ).expect(200);

    await eventually(async () => {
      await expect(wallet()).resolves.toMatchObject({
        available: 5_000,
        reserved: 0,
      });
    });
    const current = (
      await as(adminToken, 'get', `/v1/admin/refunds/${created.id}`).expect(200)
    ).body as RefundResponseDto;
    expect(current).toMatchObject({
      status: 'failed',
      failureCode: 'REFUND_FAILED',
    });
  });

  it('stays processing through a provider outage and settles on retry', async () => {
    const payment = await paidPayment(5_000, 'USD');
    mock.setRefundBehaviour('unavailable');

    const created = (await refund(payment.id, {}).expect(201))
      .body as RefundResponseDto;
    expect(created.status).toBe('processing');

    mock.setRefundBehaviour('successful');
    const retried = (
      await as(
        adminToken,
        'post',
        `/v1/admin/refunds/${created.id}/retry`,
      ).expect(200)
    ).body as RefundResponseDto;

    expect(retried.status).toBe('successful');
    await expect(wallet()).resolves.toMatchObject({
      available: 0,
      reserved: 0,
    });
  });

  it('never over-refunds under concurrent requests', async () => {
    const payment = await paidPayment(5_000, 'USD');

    const responses = await Promise.all([
      refund(payment.id, {}),
      refund(payment.id, {}),
      refund(payment.id, {}),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 422, 422]);
    await expect(wallet()).resolves.toMatchObject({
      available: 0,
      reserved: 0,
    });
  });

  it('is idempotent per Idempotency-Key', async () => {
    const payment = await paidPayment(5_000, 'USD');

    const first = (
      await refund(payment.id, { amount: 1_000 }, 'same-key').expect(201)
    ).body as RefundResponseDto;
    const again = await refund(
      payment.id,
      { amount: 1_000 },
      'same-key',
    ).expect(201);

    expect(again.headers['idempotent-replayed']).toBe('true');
    expect((again.body as RefundResponseDto).id).toBe(first.id);
    await expect(wallet()).resolves.toMatchObject({ available: 4_000 });
  });

  it('is admin-only and refuses unsettled payments', async () => {
    const pending = expectStatus(
      await as(userToken, 'post', '/v1/payments')
        .set('Idempotency-Key', 'p')
        .send({ amount: 100, currency: 'USD' }),
      201,
      'pending payment',
    ).body as PaymentResponseDto;

    await as(userToken, 'post', `/v1/admin/payments/${pending.id}/refunds`)
      .set('Idempotency-Key', 'u')
      .send({ reason: 'x' })
      .expect(403);
    const response = await refund(pending.id, {}).expect(422);
    expect(response.body).toMatchObject({ code: 'PAYMENT_NOT_REFUNDABLE' });
  });
});
