import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import {
  TransactionResponseDto,
  TransactionsPageDto,
} from '../src/transactions/dto/transaction.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { WalletsService } from '../src/wallets/wallets.service';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';

describe('Transfers and idempotency (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let aliceToken: string;
  let bobToken: string;
  let aliceWalletId: string;

  const transfer = (
    body: object,
    key?: string,
    token = aliceToken,
  ): request.Test => {
    const req = request(app.getHttpServer())
      .post('/v1/transfers')
      .set('Authorization', `Bearer ${token}`);
    if (key) req.set('Idempotency-Key', key);
    return req.send(body);
  };

  const balance = async (token: string): Promise<number> =>
    (
      (
        await request(app.getHttpServer())
          .get('/v1/wallets/primary')
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body as WalletResponseDto
    ).balances.available;

  const topUp = (amount: bigint, reference: string): Promise<unknown> =>
    app
      .get(WalletsService)
      .deposit(aliceWalletId, { amount, reference, description: 'Top-up' });

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    await resetDatabase(app.get(DataSource));
    aliceToken = (await registerUser(app, 'alice@example.com')).tokens
      .accessToken;
    bobToken = (await registerUser(app, 'bob@example.com')).tokens.accessToken;

    for (const token of [aliceToken, bobToken]) {
      await request(app.getHttpServer())
        .post('/v1/wallets')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(201);
    }
    aliceWalletId = (
      (
        await request(app.getHttpServer())
          .get('/v1/wallets/primary')
          .set('Authorization', `Bearer ${aliceToken}`)
      ).body as WalletResponseDto
    ).id;
    await topUp(10_000n, 'dep-1'); // $100.00
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  const body = {
    recipientEmail: 'bob@example.com',
    amount: 2_500,
    description: 'Dinner',
  };

  it('sends money and returns the transaction', async () => {
    const response = await transfer(body, 'key-1').expect(201);

    expect(response.body).toMatchObject({
      type: 'transfer',
      status: 'successful',
      direction: 'outgoing',
      amount: 2_500,
      currency: 'USD',
      description: 'Dinner',
    });
    expect(response.headers['idempotent-replayed']).toBeUndefined();
    await expect(balance(aliceToken)).resolves.toBe(7_500);
    await expect(balance(bobToken)).resolves.toBe(2_500);
  });

  it('requires an Idempotency-Key', async () => {
    const missing = await transfer(body).expect(400);
    expect(missing.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });

    await transfer(body, 'has spaces').expect(400);
    await expect(balance(aliceToken)).resolves.toBe(10_000);
  });

  it('replays a retry with the same key: same response, money moved once', async () => {
    const first = await transfer(body, 'key-1').expect(201);
    const retry = await transfer(body, 'key-1').expect(201);

    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    await expect(balance(bobToken)).resolves.toBe(2_500);
  });

  it('treats key order in the body as the same request', async () => {
    await transfer(body, 'key-1').expect(201);
    const reordered = {
      description: 'Dinner',
      amount: 2_500,
      recipientEmail: 'bob@example.com',
    };

    const retry = await transfer(reordered, 'key-1').expect(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
  });

  it('rejects reusing a key for a different request', async () => {
    await transfer(body, 'key-1').expect(201);

    const response = await transfer({ ...body, amount: 9_999 }, 'key-1').expect(
      422,
    );
    expect(response.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(balance(bobToken)).resolves.toBe(2_500);
  });

  it('moves money once when the same request is fired concurrently', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => transfer(body, 'key-1')),
    );

    const statuses = responses.map((r) => r.status).sort();
    // One executes; the rest see it in progress (409) or replay it (201).
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(
      responses.filter(
        (r) => r.status === 201 && !r.headers['idempotent-replayed'],
      ),
    ).toHaveLength(1);
    await expect(balance(bobToken)).resolves.toBe(2_500);
  });

  it('frees the key after a failed request so the same key can be retried', async () => {
    const tooMuch = { ...body, amount: 20_000 };

    const failed = await transfer(tooMuch, 'key-1').expect(422);
    expect(failed.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

    await topUp(10_000n, 'dep-2');
    await transfer(tooMuch, 'key-1').expect(201);
    await expect(balance(bobToken)).resolves.toBe(20_000);
  });

  it('scopes keys per user', async () => {
    await transfer(body, 'shared-key').expect(201);

    // Bob (who just received $25) reuses the same key string: it is his own, separate request.
    const response = await transfer(
      { recipientEmail: 'alice@example.com', amount: 1 },
      'shared-key',
      bobToken,
    ).expect(201);
    expect(response.headers['idempotent-replayed']).toBeUndefined();
  });

  it('shows the transfer to both parties with the right direction', async () => {
    const sent = (await transfer(body, 'key-1').expect(201))
      .body as TransactionResponseDto;

    const bobsView = (
      await request(app.getHttpServer())
        .get('/v1/transactions')
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(200)
    ).body as TransactionsPageDto;
    expect(bobsView.data).toEqual([
      expect.objectContaining({
        id: sent.id,
        direction: 'incoming',
        amount: 2_500,
      }),
    ]);

    await request(app.getHttpServer())
      .get(`/v1/transactions/${sent.id}`)
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(200);

    const carolToken = (await registerUser(app, 'carol@example.com')).tokens
      .accessToken;
    await request(app.getHttpServer())
      .get(`/v1/transactions/${sent.id}`)
      .set('Authorization', `Bearer ${carolToken}`)
      .expect(404);
  });

  it.each([
    [
      'an unknown recipient',
      { recipientEmail: 'nobody@example.com', amount: 1 },
      'RECIPIENT_NOT_FOUND',
    ],
    [
      'yourself',
      { recipientEmail: 'alice@example.com', amount: 1 },
      'SELF_TRANSFER',
    ],
  ])('refuses sending to %s', async (_label, payload, code) => {
    const response = await transfer(payload, `key-${code}`).expect(422);
    expect(response.body).toMatchObject({ code });
  });

  it.each([
    [{ recipientEmail: 'bob@example.com', amount: 0 }],
    [{ recipientEmail: 'bob@example.com', amount: 10.5 }],
    [{ recipientEmail: 'bob@example.com', amount: '100' }],
    [{ recipientEmail: 'not-an-email', amount: 100 }],
  ])('validates %p', async (payload) => {
    await transfer(payload, 'key-v').expect(400);
  });
});
