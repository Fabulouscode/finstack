import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { FxQuoteResponseDto, FxRateResponseDto } from '../src/fx/dto/fx.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';

describe('FX (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let adminToken: string;
  let userToken: string;

  const as = (
    token: string,
  ): {
    get: (path: string) => request.Test;
    post: (path: string, body: object) => request.Test;
  } => ({
    get: (path: string): request.Test =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object): request.Test =>
      request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    const dataSource = app.get(DataSource);
    await resetDatabase(dataSource);

    await registerUser(app, 'admin@example.com');
    await dataSource.query(
      `UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'`,
    );
    // Sign in again so the access token carries the admin role.
    adminToken = (
      (
        await request(app.getHttpServer())
          .post('/v1/auth/login')
          .send({
            email: 'admin@example.com',
            password: 'correct-horse-battery-staple',
          })
          .expect(200)
      ).body as { tokens: { accessToken: string } }
    ).tokens.accessToken;
    userToken = (await registerUser(app, 'user@example.com')).tokens
      .accessToken;
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  describe('rates', () => {
    it('lets admins set rates and everyone read the newest per pair', async () => {
      await as(adminToken)
        .post('/v1/fx/rates', { base: 'USD', quote: 'NGN', rate: '1500' })
        .expect(201);
      const created = await as(adminToken)
        .post('/v1/fx/rates', { base: 'USD', quote: 'NGN', rate: '1550.2500' })
        .expect(201);
      expect(created.body).toMatchObject({
        base: 'USD',
        quote: 'NGN',
        rate: '1550.25',
        source: 'admin',
      });

      const list = (await as(userToken).get('/v1/fx/rates').expect(200))
        .body as FxRateResponseDto[];
      expect(list).toEqual([
        expect.objectContaining({ base: 'USD', quote: 'NGN', rate: '1550.25' }),
      ]);
    });

    it('forbids non-admins from setting rates', async () => {
      const response = await as(userToken)
        .post('/v1/fx/rates', { base: 'USD', quote: 'NGN', rate: '1' })
        .expect(403);
      expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
    });

    it.each([
      [{ base: 'USD', quote: 'NGN', rate: 1550 }],
      [{ base: 'USD', quote: 'NGN', rate: '-1' }],
      [{ base: 'USD', quote: 'NGN', rate: '1e3' }],
      [{ base: 'USD', quote: 'XXX', rate: '1' }],
    ])('rejects invalid rate %p', async (body) => {
      await as(adminToken).post('/v1/fx/rates', body).expect(400);
    });

    it.each(['0', '0.0', '00.0000000000'])(
      'rejects the zero rate %p',
      async (rate) => {
        await as(adminToken)
          .post('/v1/fx/rates', { base: 'USD', quote: 'NGN', rate })
          .expect(400);
      },
    );

    it('rejects a pair with the same currency twice', async () => {
      const response = await as(adminToken)
        .post('/v1/fx/rates', { base: 'USD', quote: 'USD', rate: '1' })
        .expect(422);
      expect(response.body).toMatchObject({ code: 'SAME_CURRENCY' });
    });
  });

  describe('quotes', () => {
    beforeEach(async () => {
      await as(adminToken)
        .post('/v1/fx/rates', { base: 'USD', quote: 'NGN', rate: '1550' })
        .expect(201);
    });

    it('quotes what I receive for an amount I pay', async () => {
      const response = await as(userToken)
        .post('/v1/fx/quotes', {
          sourceCurrency: 'NGN',
          targetCurrency: 'USD',
          sourceAmount: 1_550_000,
        })
        .expect(201);

      expect(response.body).toMatchObject({
        sourceCurrency: 'NGN',
        sourceAmount: 1_550_000,
        targetCurrency: 'USD',
        targetAmount: 990,
        rate: '1550',
        rateBase: 'USD',
        rateQuote: 'NGN',
        spreadBps: 100,
        status: 'open',
      });
    });

    it('quotes what I pay for an amount I want to receive', async () => {
      const response = await as(userToken)
        .post('/v1/fx/quotes', {
          sourceCurrency: 'NGN',
          targetCurrency: 'USD',
          targetAmount: 1_000,
        })
        .expect(201);

      expect((response.body as FxQuoteResponseDto).sourceAmount).toBe(
        1_565_657,
      );
    });

    it.each([
      ['both amounts', { sourceAmount: 100, targetAmount: 100 }],
      ['no amount', {}],
      ['a fractional amount', { sourceAmount: 10.5 }],
      ['a numeric string', { sourceAmount: '1000' }],
    ])('rejects %s', async (_label, amounts) => {
      await as(userToken)
        .post('/v1/fx/quotes', {
          sourceCurrency: 'NGN',
          targetCurrency: 'USD',
          ...amounts,
        })
        .expect(400);
    });

    it('returns domain errors for unavailable pairs and stale rates', async () => {
      const unavailable = await as(userToken)
        .post('/v1/fx/quotes', {
          sourceCurrency: 'EUR',
          targetCurrency: 'USD',
          sourceAmount: 100,
        })
        .expect(422);
      expect(unavailable.body).toMatchObject({ code: 'FX_RATE_UNAVAILABLE' });

      await app
        .get(DataSource)
        .query(`UPDATE fx_rates SET created_at = now() - interval '2 days'`);
      const stale = await as(userToken)
        .post('/v1/fx/quotes', {
          sourceCurrency: 'NGN',
          targetCurrency: 'USD',
          sourceAmount: 1_550_000,
        })
        .expect(503);
      expect(stale.body).toMatchObject({ code: 'FX_RATE_STALE' });
    });

    it('shows a quote only to its owner', async () => {
      const quote = (
        await as(userToken)
          .post('/v1/fx/quotes', {
            sourceCurrency: 'NGN',
            targetCurrency: 'USD',
            sourceAmount: 1_550_000,
          })
          .expect(201)
      ).body as FxQuoteResponseDto;

      await as(userToken).get(`/v1/fx/quotes/${quote.id}`).expect(200);
      await as(adminToken).get(`/v1/fx/quotes/${quote.id}`).expect(404);
    });
  });
});
