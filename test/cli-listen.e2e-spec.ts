import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { buildSources } from '../src/cli/listen/build-sources';
import { Listener } from '../src/cli/listen/listener';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { FakePaystack } from './utils/fake-paystack';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

const SECRET = 'sk_test_clisecret123';

/**
 * `finstack listen` end to end: a payment completes at the provider, no
 * webhook is sent, and the CLI's listener notices it and delivers one that
 * FinStack verifies and settles.
 */
describe('finstack listen (e2e, fake Paystack API)', () => {
  const originalEnv = process.env;
  let paystack: FakePaystack;
  let paystackUrl: string;
  let app: INestApplication<App>;
  let token: string;

  const authed = (method: 'get' | 'post', path: string): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const listener = (logs: string[]): Listener => {
    const { sources, problems } = buildSources(
      {
        PAYMENT_PROVIDERS: 'paystack',
        PAYSTACK_SECRET_KEY: SECRET,
        PAYSTACK_BASE_URL: paystackUrl,
      },
      [],
      fetch,
    );
    expect(problems).toEqual([]);
    const server = app.getHttpServer() as unknown as {
      address(): AddressInfo;
    };
    const { port } = server.address();
    return new Listener({
      sources,
      forwardTo: `http://127.0.0.1:${port}`,
      since: new Date(Date.now() - 3600_000),
      replay: false,
      fetchFn: fetch,
      log: (line) => logs.push(line),
    });
  };

  beforeEach(async () => {
    paystack = new FakePaystack(SECRET);
    paystackUrl = await paystack.start();
    process.env = {
      ...originalEnv,
      AUTH_RATE_LIMIT_MAX: '50',
      PAYMENT_PROVIDERS: 'paystack',
      DEFAULT_PAYMENT_PROVIDER: 'paystack',
      PAYSTACK_SECRET_KEY: SECRET,
      PAYSTACK_BASE_URL: paystackUrl,
      DEFAULT_WALLET_CURRENCY: 'NGN',
      ALLOWED_WALLET_CURRENCIES: 'NGN',
    };
    app = await createTestApp();
    await resetDatabase(app.get(DataSource));
    token = (await registerUser(app, 'ada@example.com')).tokens.accessToken;
    expectStatus(await authed('post', '/v1/wallets').send({}), 201, 'wallet');
  });

  afterEach(async () => {
    await app.close();
    await paystack.stop();
    process.env = originalEnv;
  });

  it('delivers a payment that completed without a webhook, once', async () => {
    const logs: string[] = [];
    const cli = listener(logs);
    await cli.tick(); // starts watching

    const payment = expectStatus(
      await authed('post', '/v1/payments')
        .set('Idempotency-Key', 'cli-1')
        .send({ amount: 500_000, currency: 'NGN' }),
      201,
      'pay',
    ).body as PaymentResponseDto;
    // The customer pays; Paystack would send a webhook, but nothing can reach us.
    paystack.complete(payment.reference, 'success');

    await cli.tick();
    await cli.tick();

    await eventually(async () => {
      const wallet = (await authed('get', '/v1/wallets/primary').expect(200))
        .body as WalletResponseDto;
      expect(wallet.balances.available).toBe(500_000);
    });
    expect(logs).toEqual([
      `→ paystack charge.success ${payment.reference}  [200]`,
    ]);
  });
});
