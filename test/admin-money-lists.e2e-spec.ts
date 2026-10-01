import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import {
  AdminPaymentsPageDto,
  PaymentResponseDto,
} from '../src/payments/dto/payment.dto';
import {
  AdminPayoutsPageDto,
  PayoutDestinationResponseDto,
  PayoutResponseDto,
} from '../src/payouts/dto/payout.dto';
import {
  AdminRefundsPageDto,
  RefundResponseDto,
} from '../src/refunds/dto/refund.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';

const PASSWORD = 'correct-horse-battery-staple';

describe('Admin money lists (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let ada: AuthResponseDto;
  let bob: AuthResponseDto;
  let support: string;
  let admin: string;
  let keys = 0;

  const as = (
    token: string,
    method: 'get' | 'post',
    path: string,
  ): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const staff = async (email: string, role: string): Promise<string> => {
    await registerUser(app, email);
    await dataSource.query(`UPDATE users SET role = $1 WHERE email = $2`, [
      role,
      email,
    ]);
    return (
      expectStatus(
        await request(app.getHttpServer())
          .post('/v1/auth/login')
          .send({ email, password: PASSWORD }),
        200,
        'staff login',
      ).body as AuthResponseDto
    ).tokens.accessToken;
  };

  /** A paid payment (sandbox test money). */
  const fund = async (
    user: AuthResponseDto,
    amount: number,
  ): Promise<PaymentResponseDto> =>
    expectStatus(
      await as(
        user.tokens.accessToken,
        'post',
        '/v1/sandbox/wallets/fund',
      ).send({ amount }),
      201,
      'fund',
    ).body as PaymentResponseDto;

  /** A payment the customer hasn't paid yet. */
  const pending = async (user: AuthResponseDto): Promise<PaymentResponseDto> =>
    expectStatus(
      await as(user.tokens.accessToken, 'post', '/v1/payments')
        .set('Idempotency-Key', `pay-${++keys}`)
        .send({ amount: 700, currency: 'USD' }),
      201,
      'pending payment',
    ).body as PaymentResponseDto;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    await resetDatabase(dataSource);
    ada = await registerUser(app, 'ada@example.com');
    bob = await registerUser(app, 'bob@example.com');
    for (const user of [ada, bob]) {
      await as(user.tokens.accessToken, 'post', '/v1/wallets')
        .send({})
        .expect(201);
    }
    support = await staff('support@example.com', 'support');
    admin = await staff('admin@example.com', 'admin');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('payments', () => {
    let adaPaid: PaymentResponseDto;
    let adaPending: PaymentResponseDto;
    let bobPaid: PaymentResponseDto;

    beforeAll(async () => {
      adaPaid = await fund(ada, 5_000);
      adaPending = await pending(ada);
      bobPaid = await fund(bob, 9_000);
    });

    const list = async (query = ''): Promise<AdminPaymentsPageDto> =>
      (await as(support, 'get', `/v1/admin/payments${query}`).expect(200))
        .body as AdminPaymentsPageDto;

    it('lists every payment for support staff, newest first', async () => {
      const page = await list();
      expect(page.data.map((p) => p.id)).toEqual([
        bobPaid.id,
        adaPending.id,
        adaPaid.id,
      ]);
      expect(page.nextCursor).toBeNull();
    });

    it('filters by status, owner and provider', async () => {
      expect((await list('?status=successful')).data.map((p) => p.id)).toEqual([
        bobPaid.id,
        adaPaid.id,
      ]);
      expect(
        (await list(`?userId=${ada.user.id}`)).data.map((p) => p.id),
      ).toEqual([adaPending.id, adaPaid.id]);
      expect(
        (await list(`?userId=${ada.user.id}&status=pending`)).data.map(
          (p) => p.id,
        ),
      ).toEqual([adaPending.id]);
      expect((await list('?provider=stripe')).data).toEqual([]);
    });

    it('pages without duplicates or gaps', async () => {
      const seen: string[] = [];
      let cursor: string | null = '';
      while (cursor !== null) {
        const page = await list(`?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...page.data.map((p) => p.id));
        cursor = page.nextCursor;
      }
      expect(seen).toEqual([bobPaid.id, adaPending.id, adaPaid.id]);
    });

    it('shows any one payment', async () => {
      const shown = (
        await as(support, 'get', `/v1/admin/payments/${adaPaid.id}`).expect(200)
      ).body as PaymentResponseDto;
      expect(shown).toMatchObject({ id: adaPaid.id, status: 'successful' });
      await as(
        support,
        'get',
        '/v1/admin/payments/00000000-0000-4000-8000-000000000000',
      ).expect(404);
    });

    it('rejects invalid filters and cursors', async () => {
      await as(support, 'get', '/v1/admin/payments?status=paid').expect(400);
      await as(support, 'get', '/v1/admin/payments?userId=ada').expect(400);
      await as(support, 'get', '/v1/admin/payments?limit=500').expect(400);
      const bad = await as(
        support,
        'get',
        '/v1/admin/payments?cursor=not-a-cursor',
      ).expect(400);
      expect(bad.body).toMatchObject({ code: 'INVALID_CURSOR' });
    });
  });

  describe('refunds', () => {
    let refund: RefundResponseDto;

    beforeAll(async () => {
      const paid = await fund(ada, 3_000);
      refund = expectStatus(
        await as(admin, 'post', `/v1/admin/payments/${paid.id}/refunds`)
          .set('Idempotency-Key', 'refund-1')
          .send({ reason: 'Duplicate order' }),
        201,
        'refund',
      ).body as RefundResponseDto;
    });

    it('lets support staff read refunds, but not make them', async () => {
      const page = (await as(support, 'get', '/v1/admin/refunds').expect(200))
        .body as AdminRefundsPageDto;
      expect(page.data.map((r) => r.id)).toEqual([refund.id]);

      const byPayment = (
        await as(
          support,
          'get',
          `/v1/admin/refunds?paymentId=${refund.paymentId}&status=successful`,
        ).expect(200)
      ).body as AdminRefundsPageDto;
      expect(byPayment.data).toHaveLength(1);

      await as(support, 'get', `/v1/admin/refunds/${refund.id}`).expect(200);
      await as(
        support,
        'post',
        `/v1/admin/payments/${refund.paymentId}/refunds`,
      )
        .set('Idempotency-Key', 'support-refund')
        .send({ reason: 'Trying' })
        .expect(403);
    });
  });

  describe('payouts', () => {
    let paid: PayoutResponseDto;
    let rejected: PayoutResponseDto;

    beforeAll(async () => {
      await fund(bob, 5_000);
      const send = async (
        accountNumber: string,
      ): Promise<PayoutResponseDto> => {
        const destination = expectStatus(
          await as(
            bob.tokens.accessToken,
            'post',
            '/v1/payout-destinations',
          ).send({
            currency: 'USD',
            bankCode: '058',
            accountNumber,
            accountName: 'Bob Builder',
          }),
          201,
          'destination',
        ).body as PayoutDestinationResponseDto;
        return expectStatus(
          await as(bob.tokens.accessToken, 'post', '/v1/payouts')
            .set('Idempotency-Key', `payout-${++keys}`)
            .send({ destinationId: destination.id, amount: 1_000 }),
          201,
          'payout',
        ).body as PayoutResponseDto;
      };
      paid = await send('1234567890');
      // Test account ending 0001: the bank rejects it.
      rejected = await send('1234560001');
    });

    it('lists payouts, filterable by status and owner', async () => {
      const list = async (query = ''): Promise<string[]> =>
        (
          (await as(support, 'get', `/v1/admin/payouts${query}`).expect(200))
            .body as AdminPayoutsPageDto
        ).data.map((p) => p.id);

      expect(await list()).toEqual([rejected.id, paid.id]);
      expect(await list('?status=failed')).toEqual([rejected.id]);
      expect(await list(`?userId=${ada.user.id}`)).toEqual([]);
    });
  });

  it('is staff-only', async () => {
    for (const path of [
      '/v1/admin/payments',
      '/v1/admin/refunds',
      '/v1/admin/payouts',
    ]) {
      await as(ada.tokens.accessToken, 'get', path).expect(403);
      await request(app.getHttpServer()).get(path).expect(401);
    }
  });
});
