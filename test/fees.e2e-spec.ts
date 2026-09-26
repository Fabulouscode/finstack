import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import {
  FeeQuoteResponseDto,
  FeeRuleResponseDto,
} from '../src/fees/dto/fee.dto';
import { AdminRateProvider } from '../src/fx/admin-rate.provider';
import { LedgerService } from '../src/ledger/ledger.service';
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
import {
  TransactionResponseDto,
  TransactionsPageDto,
} from '../src/transactions/dto/transaction.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

describe('Fees (e2e)', () => {
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

  const setRule = async (rule: object): Promise<FeeRuleResponseDto> =>
    expectStatus(
      await as(admin.tokens.accessToken, 'post', '/v1/admin/fee-rules').send(
        rule,
      ),
      201,
      'set rule',
    ).body as FeeRuleResponseDto;

  const balances = async (
    token = ada.tokens.accessToken,
  ): Promise<WalletResponseDto['balances']> =>
    (
      (await as(token, 'get', '/v1/wallets/primary').expect(200))
        .body as WalletResponseDto
    ).balances;

  const feeRevenue = async (currency = 'USD'): Promise<number> => {
    const [row] = await dataSource.query<{ balance: string }[]>(
      'SELECT balance FROM ledger_accounts WHERE code = $1',
      [`system:fee-revenue:${currency}`],
    );
    return Number(row?.balance ?? 0);
  };

  const startPayment = (body: object, path = '/v1/payments'): request.Test =>
    asAda('post', path).set('Idempotency-Key', `pay-${++keys}`).send(body);

  const settle = async (
    payment: PaymentResponseDto,
  ): Promise<PaymentResponseDto> => {
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
      const current = (
        await asAda('get', `/v1/payments/${payment.id}`).expect(200)
      ).body as PaymentResponseDto;
      expect(current.status).toBe('successful');
      return current;
    });
  };

  /** Funds Ada's wallet with no fee rule in place. */
  const fund = async (amount: number): Promise<void> => {
    await settle(
      expectStatus(await startPayment({ amount, currency: 'USD' }), 201, 'fund')
        .body as PaymentResponseDto,
    );
  };

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '100' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    mock = app.get(MockPaymentProvider);
    mock.setPayoutBehaviour('pending');
    await resetDatabase(dataSource);
    await app
      .get(AdminRateProvider)
      .setRate({ base: 'USD', quote: 'NGN', rate: '1550', userId: null });

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
    expectStatus(await asAda('post', '/v1/wallets').send({}), 201, 'wallet');
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

  describe('payments', () => {
    it('takes the fee from the credit, into fee revenue', async () => {
      await setRule({
        operation: 'payment',
        currency: 'USD',
        fixedAmount: 30,
        percentageBps: 290,
      });

      const started = expectStatus(
        await startPayment({ amount: 10_000, currency: 'USD' }),
        201,
        'payment',
      ).body as PaymentResponseDto;
      expect(started.fee).toEqual({ amount: 320, currency: 'USD' });

      await settle(started);
      expect(await balances()).toMatchObject({ available: 9_680 });
      expect(await feeRevenue()).toBe(320);
    });

    it('charges converted payments in the wallet currency', async () => {
      await setRule({
        operation: 'payment',
        currency: 'USD',
        percentageBps: 100,
      });

      // ₦15,500 at 1550 with a 1% spread credits $9.90; 1% of that is 10¢.
      const started = expectStatus(
        await startPayment({ amount: 1_550_000, currency: 'NGN' }),
        201,
        'payment',
      ).body as PaymentResponseDto;
      expect(started.conversion?.amount).toBe(990);
      expect(started.fee).toEqual({ amount: 10, currency: 'USD' });

      await settle(started);
      expect((await balances()).available).toBe(980);
    });

    it('refuses payments that would not cover their fee', async () => {
      await setRule({
        operation: 'payment',
        currency: 'USD',
        fixedAmount: 500,
      });

      const response = await startPayment({ amount: 400, currency: 'USD' });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ code: 'AMOUNT_TOO_SMALL' });
    });

    it('locks the fee when the payment starts', async () => {
      await setRule({
        operation: 'payment',
        currency: 'USD',
        fixedAmount: 100,
      });
      const started = expectStatus(
        await startPayment({ amount: 10_000, currency: 'USD' }),
        201,
        'payment',
      ).body as PaymentResponseDto;

      await setRule({
        operation: 'payment',
        currency: 'USD',
        fixedAmount: 900,
      });
      await settle(started);

      expect((await balances()).available).toBe(9_900);
    });

    it('takes the fee from pending funds during a settlement hold', async () => {
      await app.close();
      process.env.PAYMENT_SETTLEMENT_DELAY_SECONDS = '3600';
      app = await createTestApp();
      mock = app.get(MockPaymentProvider);
      await setRule({
        operation: 'payment',
        currency: 'USD',
        fixedAmount: 100,
      });

      const settled = await settle(
        expectStatus(
          await startPayment({ amount: 10_000, currency: 'USD' }),
          201,
          'payment',
        ).body as PaymentResponseDto,
      );

      expect(settled.heldAmount).toBe(9_900);
      expect(await balances()).toEqual({
        available: 0,
        pending: 9_900,
        reserved: 0,
      });
    });
  });

  describe('transfers', () => {
    it('adds the fee on top, paid by the sender only', async () => {
      await fund(5_000);
      const bob = await registerUser(app, 'bob@example.com');
      await as(bob.tokens.accessToken, 'post', '/v1/wallets')
        .send({})
        .expect(201);
      await setRule({
        operation: 'transfer',
        currency: 'USD',
        fixedAmount: 50,
      });

      const sent = expectStatus(
        await asAda('post', '/v1/transfers')
          .set('Idempotency-Key', 'transfer-1')
          .send({ recipientEmail: 'bob@example.com', amount: 1_000 }),
        201,
        'transfer',
      ).body as TransactionResponseDto;
      expect(sent.fee).toEqual({ amount: 50, currency: 'USD' });

      expect((await balances()).available).toBe(3_950);
      expect((await balances(bob.tokens.accessToken)).available).toBe(1_000);
      const bobsView = (
        await as(bob.tokens.accessToken, 'get', '/v1/transactions').expect(200)
      ).body as TransactionsPageDto;
      expect(bobsView.data[0]?.fee).toBeNull();
      expect(await feeRevenue()).toBe(50);
    });

    it('needs the amount and the fee to be available', async () => {
      await fund(1_000);
      await registerUser(app, 'bob@example.com').then((bob) =>
        as(bob.tokens.accessToken, 'post', '/v1/wallets').send({}).expect(201),
      );
      await setRule({
        operation: 'transfer',
        currency: 'USD',
        fixedAmount: 50,
      });

      const response = await asAda('post', '/v1/transfers')
        .set('Idempotency-Key', 'too-much')
        .send({ recipientEmail: 'bob@example.com', amount: 1_000 });
      expect(response.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      expect((await balances()).available).toBe(1_000);
    });
  });

  describe('payouts', () => {
    const payout = async (amount: number): Promise<PayoutResponseDto> => {
      const destination = (
        await asAda('post', '/v1/payout-destinations')
          .send({
            currency: 'USD',
            bankCode: '058',
            accountNumber: '0123456789',
          })
          .expect(201)
      ).body as PayoutDestinationResponseDto;
      return expectStatus(
        await asAda('post', '/v1/payouts')
          .set('Idempotency-Key', `payout-${++keys}`)
          .send({ destinationId: destination.id, amount }),
        201,
        'payout',
      ).body as PayoutResponseDto;
    };
    const deliver = async (
      reference: string,
      outcome: 'successful' | 'failed' | 'reversed',
    ): Promise<void> => {
      const { rawBody, signature } = mock.simulatePayoutOutcome(
        reference,
        outcome,
      );
      await request(app.getHttpServer())
        .post('/v1/webhooks/mock')
        .set('Content-Type', 'application/json')
        .set(MOCK_SIGNATURE_HEADER, signature)
        .send(rawBody.toString('utf8'))
        .expect(200);
    };
    const statusOf = (id: string, status: string): Promise<void> =>
      eventually(async () => {
        const current = (await asAda('get', `/v1/payouts/${id}`).expect(200))
          .body as PayoutResponseDto;
        expect(current.status).toBe(status);
      });

    beforeEach(async () => {
      await fund(10_000);
      await setRule({ operation: 'payout', currency: 'USD', fixedAmount: 100 });
    });

    it('holds the fee with the amount and collects it on success', async () => {
      const created = await payout(4_000);
      expect(created.fee).toEqual({ amount: 100, currency: 'USD' });
      expect(await balances()).toMatchObject({
        available: 5_900,
        reserved: 4_100,
      });

      await deliver(created.reference, 'successful');
      await statusOf(created.id, 'successful');
      expect(await balances()).toMatchObject({ available: 5_900, reserved: 0 });
      expect(await feeRevenue()).toBe(100);

      const overview = (
        await as(admin.tokens.accessToken, 'get', '/v1/admin/overview').expect(
          200,
        )
      ).body as { revenue: { fees: Record<string, number> } };
      expect(overview.revenue.fees).toEqual({ USD: 100 });
    });

    it('releases the fee when the payout fails', async () => {
      const created = await payout(4_000);
      await deliver(created.reference, 'failed');
      await statusOf(created.id, 'failed');
      expect(await balances()).toMatchObject({
        available: 10_000,
        reserved: 0,
      });
      expect(await feeRevenue()).toBe(0);
    });

    it('refunds the fee when the bank returns the payout', async () => {
      const created = await payout(4_000);
      await deliver(created.reference, 'successful');
      await statusOf(created.id, 'successful');
      await deliver(created.reference, 'reversed');
      await statusOf(created.id, 'reversed');
      expect((await balances()).available).toBe(10_000);
      expect(await feeRevenue()).toBe(0);
    });
  });

  describe('rules', () => {
    it('lets organizations have their own rate, and falls back when it is retired', async () => {
      await setRule({
        operation: 'payment',
        currency: 'USD',
        percentageBps: 290,
      });
      const orgId = (
        expectStatus(
          await asAda('post', '/v1/organizations').send({ name: 'Acme' }),
          201,
          'org',
        ).body as OrganizationResponseDto
      ).id;
      const own = await setRule({
        operation: 'payment',
        currency: 'USD',
        organizationId: orgId,
        percentageBps: 100,
      });

      const quote = async (path: string): Promise<FeeQuoteResponseDto> =>
        (
          await asAda(
            'get',
            `${path}?operation=payment&currency=USD&amount=10000`,
          ).expect(200)
        ).body as FeeQuoteResponseDto;
      expect(
        await quote(`/v1/organizations/${orgId}/fees/quote`),
      ).toMatchObject({
        fee: 100,
        total: 9_900,
      });
      expect(await quote('/v1/fees/quote')).toMatchObject({ fee: 290 });

      await as(
        admin.tokens.accessToken,
        'post',
        `/v1/admin/fee-rules/${own.id}/retire`,
      ).expect(200);
      expect(
        await quote(`/v1/organizations/${orgId}/fees/quote`),
      ).toMatchObject({
        fee: 290,
      });
    });

    it('keeps history: a new rule supersedes the old one', async () => {
      const first = await setRule({
        operation: 'payout',
        currency: 'USD',
        fixedAmount: 100,
      });
      const second = await setRule({
        operation: 'payout',
        currency: 'USD',
        fixedAmount: 150,
        maxAmount: 1_000,
      });

      const active = (
        await as(admin.tokens.accessToken, 'get', '/v1/admin/fee-rules').expect(
          200,
        )
      ).body as FeeRuleResponseDto[];
      expect(active.map((r) => r.id)).toEqual([second.id]);
      const history = (
        await as(
          admin.tokens.accessToken,
          'get',
          '/v1/admin/fee-rules?history=true',
        ).expect(200)
      ).body as FeeRuleResponseDto[];
      expect(history.map((r) => [r.id, r.active])).toEqual([
        [second.id, true],
        [first.id, false],
      ]);

      const [entry] = await dataSource.query<
        { metadata: { replaces: string } }[]
      >(`SELECT metadata FROM audit_logs WHERE target_id = $1`, [second.id]);
      expect(entry?.metadata.replaces).toBe(first.id);
    });

    it('validates rules and is admin-only', async () => {
      await as(admin.tokens.accessToken, 'post', '/v1/admin/fee-rules')
        .send({
          operation: 'payout',
          currency: 'USD',
          minAmount: 500,
          maxAmount: 100,
        })
        .expect(422);
      await as(admin.tokens.accessToken, 'post', '/v1/admin/fee-rules')
        .send({ operation: 'payout', currency: 'USD', percentageBps: 10_001 })
        .expect(400);
      await asAda('post', '/v1/admin/fee-rules')
        .send({ operation: 'payout', currency: 'USD', fixedAmount: 1 })
        .expect(403);
    });
  });
});
