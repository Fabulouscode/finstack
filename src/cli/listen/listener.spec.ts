import { buildSources } from './build-sources';
import { Delivery, EventSource, FetchFn } from './event-source';
import { Listener, MAX_DELIVERY_ATTEMPTS } from './listener';

const delivery = (key: string): Delivery => ({
  key,
  provider: 'paystack',
  type: 'charge.success',
  reference: `trx_${key}`,
  body: `{"key":"${key}"}`,
  headers: { 'x-paystack-signature': 'sig' },
});

/** A source whose events are whatever the test puts in `events`. */
class FakeSource implements EventSource {
  readonly provider = 'paystack';
  events: Delivery[] = [];
  failure: Error | null = null;
  poll(): Promise<Delivery[]> {
    return this.failure
      ? Promise.reject(this.failure)
      : Promise.resolve(this.events);
  }
}

function setup(replay = false): {
  source: FakeSource;
  listener: Listener;
  posted: { url: string; body: string; headers: Record<string, string> }[];
  logs: string[];
  respondWith: (status: number) => void;
} {
  const source = new FakeSource();
  const posted: {
    url: string;
    body: string;
    headers: Record<string, string>;
  }[] = [];
  const logs: string[] = [];
  let status = 200;
  const fetchFn = ((url: string, init: RequestInit) => {
    posted.push({
      url,
      body: init.body as string,
      headers: init.headers as Record<string, string>,
    });
    return Promise.resolve(new Response('{}', { status }));
  }) as unknown as FetchFn;
  const listener = new Listener({
    sources: [source],
    forwardTo: 'http://localhost:3000',
    since: new Date(0),
    replay,
    fetchFn,
    log: (line) => logs.push(line),
  });
  return {
    source,
    listener,
    posted,
    logs,
    respondWith: (next) => {
      status = next;
    },
  };
}

describe('Listener', () => {
  it('notes what already exists on start, then delivers only new events, once', async () => {
    const { source, listener, posted } = setup();
    source.events = [delivery('old')];
    await listener.tick();
    expect(posted).toHaveLength(0);

    source.events = [delivery('old'), delivery('new')];
    await listener.tick();
    await listener.tick();

    expect(posted).toEqual([
      {
        url: 'http://localhost:3000/v1/webhooks/paystack',
        body: '{"key":"new"}',
        headers: {
          'Content-Type': 'application/json',
          'x-paystack-signature': 'sig',
        },
      },
    ]);
  });

  it('delivers existing events too when replaying', async () => {
    const { source, listener, posted } = setup(true);
    source.events = [delivery('old')];
    await listener.tick();
    expect(posted).toHaveLength(1);
  });

  it('retries a delivery FinStack refused, and gives up after the limit', async () => {
    const { source, listener, posted, logs, respondWith } = setup();
    await listener.tick();
    source.events = [delivery('a')];
    respondWith(500);

    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 2; i++) await listener.tick();

    expect(posted).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect(logs.at(-1)).toContain('giving up');
  });

  it('delivers on a later poll once FinStack accepts', async () => {
    const { source, listener, posted, logs, respondWith } = setup();
    await listener.tick();
    source.events = [delivery('a')];
    respondWith(503);
    await listener.tick();
    respondWith(200);
    await listener.tick();
    await listener.tick();

    expect(posted).toHaveLength(2);
    expect(logs.at(-1)).toMatch(/^→ paystack charge\.success trx_a {2}\[200\]/);
  });

  it('reports a failing provider once, not on every poll, and keeps going', async () => {
    const { source, listener, logs } = setup();
    source.failure = new Error('HTTP 401 from api.paystack.co: Invalid key');
    await listener.tick();
    await listener.tick();
    expect(logs).toEqual([
      '! paystack: HTTP 401 from api.paystack.co: Invalid key',
    ]);

    source.failure = null;
    await expect(listener.tick()).resolves.toBeUndefined();
  });
});

describe('buildSources', () => {
  const fetchFn = fetch;

  it('listens to the enabled providers that can be listened to', () => {
    const { sources, problems } = buildSources(
      {
        PAYMENT_PROVIDERS: 'mock,paystack,flutterwave',
        PAYSTACK_SECRET_KEY: 'sk_test_abc',
        FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-abc-X',
        FLUTTERWAVE_WEBHOOK_SECRET_HASH: 'hash',
      },
      [],
      fetchFn,
    );
    expect(problems).toEqual([]);
    expect(sources.map((s) => s.provider)).toEqual(['paystack', 'flutterwave']);
  });

  it('refuses live keys', () => {
    const { sources, problems } = buildSources(
      {
        PAYSTACK_SECRET_KEY: 'sk_live_abc',
        STRIPE_SECRET_KEY: 'sk_live_abc',
        STRIPE_WEBHOOK_SECRET: 'whsec_abc',
        FLUTTERWAVE_SECRET_KEY: 'FLWSECK-abc-X',
        FLUTTERWAVE_WEBHOOK_SECRET_HASH: 'hash',
      },
      ['paystack', 'stripe', 'flutterwave'],
      fetchFn,
    );
    expect(sources).toEqual([]);
    expect(problems).toHaveLength(3);
    expect(problems.every((p) => p.includes('only test keys'))).toBe(true);
  });

  it('says what is missing', () => {
    expect(buildSources({}, ['stripe'], fetchFn).problems).toEqual([
      'stripe: set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (any whsec_ value works locally)',
    ]);
    expect(buildSources({}, [], fetchFn).problems[0]).toMatch(
      /^no provider to listen to/,
    );
    expect(buildSources({}, ['mock'], fetchFn).problems[0]).toMatch(
      /^mock: not a provider to listen to/,
    );
  });
});
