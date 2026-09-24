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

describe('Wallets (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let aliceToken: string;
  let bobToken: string;

  interface AuthedClient {
    get: (path: string) => request.Test;
    post: (path: string, body: object) => request.Test;
  }

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
    currency = 'NGN',
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
    await request(app.getHttpServer()).get('/v1/wallets').expect(401);
    await request(app.getHttpServer())
      .post('/v1/wallets')
      .send({ currency: 'NGN' })
      .expect(401);
  });

  it('opens a wallet with zero balances', async () => {
    const wallet = await openWallet(aliceToken);

    expect(wallet).toMatchObject({
      currency: 'NGN',
      status: 'active',
      balances: { available: 0, pending: 0, reserved: 0 },
    });
  });

  it('rejects a second wallet in the same currency', async () => {
    await openWallet(aliceToken);

    const response = await api(aliceToken)
      .post('/v1/wallets', { currency: 'NGN' })
      .expect(409);
    expect(response.body).toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
  });

  it.each(['ngn', 'XXX', 123, undefined])(
    'rejects currency %p',
    async (currency) => {
      const response = await api(aliceToken)
        .post('/v1/wallets', { currency })
        .expect(400);
      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    },
  );

  it('lists and fetches only my wallets', async () => {
    const ngn = await openWallet(aliceToken, 'NGN');
    await openWallet(aliceToken, 'USD');
    await openWallet(bobToken, 'NGN');

    const list = (await api(aliceToken).get('/v1/wallets').expect(200))
      .body as WalletResponseDto[];
    expect(list.map((w) => w.currency)).toEqual(['NGN', 'USD']);

    await api(aliceToken).get(`/v1/wallets/${ngn.id}`).expect(200);
    const response = await api(bobToken)
      .get(`/v1/wallets/${ngn.id}`)
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
        amount: BigInt(i * 100_000),
        reference: `dep-${i}`,
        description: `Top-up ${i}`,
      });
    }
    await service.withdraw(wallet.id, {
      amount: 50_000n,
      reference: 'wd-1',
      description: 'Payout',
    });

    const fetched = (
      await api(aliceToken).get(`/v1/wallets/${wallet.id}`).expect(200)
    ).body as WalletResponseDto;
    expect(fetched.balances.available).toBe(1_450_000);

    const first = (
      await api(aliceToken)
        .get(`/v1/wallets/${wallet.id}/entries?limit=4`)
        .expect(200)
    ).body as WalletEntriesPageDto;
    expect(first.data.map((e) => [e.reference, e.type, e.amount])).toEqual([
      ['wd-1', 'debit', 50_000],
      ['dep-5', 'credit', 500_000],
      ['dep-4', 'credit', 400_000],
      ['dep-3', 'credit', 300_000],
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
