import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import {
  WalletEntriesPageDto,
  WalletResponseDto,
} from '../src/wallets/dto/wallet.dto';
import { WalletsService } from '../src/wallets/wallets.service';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';

interface AuthedClient {
  get: (path: string) => request.Test;
  post: (path: string, body: object) => request.Test;
}

describe('Wallets (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let aliceToken: string;
  let bobToken: string;

  const api = (token: string): AuthedClient => ({
    get: (path) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`),
    post: (path, body) =>
      request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });

  async function openWallet(
    token: string,
    currency = 'USD',
  ): Promise<WalletResponseDto> {
    const response = await api(token)
      .post('/v1/wallets', { currency })
      .expect(201);
    return response.body as WalletResponseDto;
  }

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    await resetDatabase(app.get(DataSource));
    aliceToken = (await registerUser(app, 'alice@example.com')).tokens
      .accessToken;
    bobToken = (await registerUser(app, 'bob@example.com')).tokens.accessToken;
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/v1/wallets/primary').expect(401);
    await request(app.getHttpServer())
      .post('/v1/wallets')
      .send({ currency: 'USD' })
      .expect(401);
  });

  it('opens a USD wallet by default, with zero balances', async () => {
    const response = await api(aliceToken).post('/v1/wallets', {}).expect(201);

    expect(response.body).toMatchObject({
      currency: 'USD',
      status: 'active',
      isPrimary: true,
      balances: { available: 0, pending: 0, reserved: 0 },
    });
  });

  it('opens a wallet in another supported base currency', async () => {
    const wallet = await openWallet(aliceToken, 'NGN');

    expect(wallet.currency).toBe('NGN');
  });

  it('rejects a second wallet, whatever the currency', async () => {
    await openWallet(aliceToken, 'USD');

    for (const currency of ['USD', 'NGN']) {
      const response = await api(aliceToken)
        .post('/v1/wallets', { currency })
        .expect(409);
      expect(response.body).toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
    }
  });

  it.each(['usd', 'XXX', 123, null])(
    'rejects currency %p',
    async (currency) => {
      const response = await api(aliceToken)
        .post('/v1/wallets', { currency })
        .expect(400);
      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    },
  );

  it('returns my primary wallet, and 404 before one is opened', async () => {
    const missing = await api(aliceToken)
      .get('/v1/wallets/primary')
      .expect(404);
    expect(missing.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });

    const opened = await openWallet(aliceToken);
    const mine = (await api(aliceToken).get('/v1/wallets/primary').expect(200))
      .body as WalletResponseDto;
    expect(mine.id).toBe(opened.id);
  });

  it("hides other users' wallets", async () => {
    const alices = await openWallet(aliceToken);
    await openWallet(bobToken);

    await api(aliceToken).get(`/v1/wallets/${alices.id}`).expect(200);
    const response = await api(bobToken)
      .get(`/v1/wallets/${alices.id}`)
      .expect(404);
    expect(response.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });

  it('returns 400 for a malformed wallet id', async () => {
    await api(aliceToken).get('/v1/wallets/not-a-uuid').expect(400);
  });

  it('reflects ledger movements in balances and paginated history', async () => {
    const wallet = await openWallet(aliceToken);
    const service = app.get(WalletsService);
    for (let i = 1; i <= 5; i++) {
      await service.deposit(wallet.id, {
        amount: BigInt(i * 1_000),
        reference: `dep-${i}`,
        description: `Top-up ${i}`,
      });
    }
    await service.withdraw(wallet.id, {
      amount: 500n,
      reference: 'wd-1',
      description: 'Payout',
    });

    const fetched = (
      await api(aliceToken).get('/v1/wallets/primary').expect(200)
    ).body as WalletResponseDto;
    expect(fetched.balances.available).toBe(14_500); // $145.00

    const first = (
      await api(aliceToken)
        .get(`/v1/wallets/${wallet.id}/entries?limit=4`)
        .expect(200)
    ).body as WalletEntriesPageDto;
    expect(first.data.map((e) => [e.reference, e.type, e.amount])).toEqual([
      ['wd-1', 'debit', 500],
      ['dep-5', 'credit', 5_000],
      ['dep-4', 'credit', 4_000],
      ['dep-3', 'credit', 3_000],
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = (
      await api(aliceToken)
        .get(
          `/v1/wallets/${wallet.id}/entries?limit=4&cursor=${first.nextCursor}`,
        )
        .expect(200)
    ).body as WalletEntriesPageDto;
    expect(second.data.map((e) => e.reference)).toEqual(['dep-2', 'dep-1']);
    expect(second.nextCursor).toBeNull();
  });

  it('validates pagination parameters', async () => {
    const wallet = await openWallet(aliceToken);

    await api(aliceToken)
      .get(`/v1/wallets/${wallet.id}/entries?limit=0`)
      .expect(400);
    await api(aliceToken)
      .get(`/v1/wallets/${wallet.id}/entries?limit=500`)
      .expect(400);
    const response = await api(aliceToken)
      .get(`/v1/wallets/${wallet.id}/entries?cursor=bogus`)
      .expect(400);
    expect(response.body).toMatchObject({ code: 'INVALID_CURSOR' });
  });
});

describe('Wallets: operator-restricted base currencies (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      DEFAULT_WALLET_CURRENCY: 'USD',
      ALLOWED_WALLET_CURRENCIES: 'USD',
    };
    app = await createTestApp();
    await resetDatabase(app.get(DataSource));
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  it('refuses base currencies the operator has not allowed', async () => {
    const { accessToken } = (await registerUser(app, 'ada@example.com')).tokens;

    const response = await request(app.getHttpServer())
      .post('/v1/wallets')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currency: 'NGN' })
      .expect(422);

    expect(response.body).toMatchObject({
      code: 'WALLET_CURRENCY_NOT_ALLOWED',
      detail: 'Wallets can only be opened in: USD',
    });
  });
});

describe('Wallets in multiple mode (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let token: string;

  const call = (
    method: 'get' | 'post',
    path: string,
    body?: object,
  ): request.Test => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      WALLETS_PER_OWNER: 'multiple',
      ALLOWED_WALLET_CURRENCIES: 'USD,NGN',
    };
    app = await createTestApp();
    await resetDatabase(app.get(DataSource));
    token = (await registerUser(app, 'ada@example.com')).tokens.accessToken;
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  it('opens a wallet per currency, lists primary first, and switches the primary', async () => {
    const usd = (await call('post', '/v1/wallets', {}).expect(201))
      .body as WalletResponseDto;
    const ngn = (
      await call('post', '/v1/wallets', { currency: 'NGN' }).expect(201)
    ).body as WalletResponseDto;
    expect([usd.isPrimary, ngn.isPrimary]).toEqual([true, false]);

    const duplicate = await call('post', '/v1/wallets', {
      currency: 'NGN',
    }).expect(409);
    expect(duplicate.body).toMatchObject({
      code: 'WALLET_ALREADY_EXISTS',
      detail: 'A NGN wallet already exists',
    });

    const switched = (
      await call('post', `/v1/wallets/${ngn.id}/primary`).expect(200)
    ).body as WalletResponseDto;
    expect(switched).toMatchObject({ id: ngn.id, isPrimary: true });

    const list = (await call('get', '/v1/wallets').expect(200))
      .body as WalletResponseDto[];
    expect(list.map((w) => [w.currency, w.isPrimary])).toEqual([
      ['NGN', true],
      ['USD', false],
    ]);
    const primary = (await call('get', '/v1/wallets/primary').expect(200))
      .body as WalletResponseDto;
    expect(primary.id).toBe(ngn.id);
  });
});
