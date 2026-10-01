import { paymentsConfigFixture } from '../../config/testing/payments-config.fixture';
import { FlutterwaveProvider } from '../../payment-providers/flutterwave/flutterwave.provider';
import { JsonHttpClient } from '../../payment-providers/http/json-http-client';
import {
  PaymentProvider,
  ProviderWebhookEvent,
} from '../../payment-providers/payment-provider';
import { PaystackProvider } from '../../payment-providers/paystack/paystack.provider';
import { StripeProvider } from '../../payment-providers/stripe/stripe.provider';
import { Delivery, FetchFn } from './event-source';
import { FlutterwaveSource } from './flutterwave-source';
import { PaystackSource } from './paystack-source';
import { StripeSource } from './stripe-source';

const PAYSTACK_KEY = 'sk_test_cli123';
const STRIPE_KEY = 'sk_test_cli123';
const STRIPE_SECRET = 'whsec_cli123';
const FLW_KEY = 'FLWSECK_TEST-cli123-X';
const FLW_HASH = 'cli-flutterwave-secret-hash';

const config = paymentsConfigFixture({
  paystack: { secretKey: PAYSTACK_KEY, baseUrl: 'https://x', timeoutMs: 1000 },
  stripe: {
    secretKey: STRIPE_KEY,
    webhookSecret: STRIPE_SECRET,
    baseUrl: 'https://x',
    timeoutMs: 1000,
    webhookToleranceSeconds: 300,
    successUrl: 'https://x',
    cancelUrl: 'https://x',
  },
  flutterwave: {
    secretKey: FLW_KEY,
    webhookSecretHash: FLW_HASH,
    baseUrl: 'https://x',
    timeoutMs: 1000,
    redirectUrl: 'https://x',
  },
});
// FinStack's real adapters, used only to check the CLI's webhooks.
const http = new JsonHttpClient();
const adapters = {
  paystack: new PaystackProvider(config, http),
  stripe: new StripeProvider(config, http),
  flutterwave: new FlutterwaveProvider(config, http),
};

/** Answers by URL path; records each request. */
function fakeApi(routes: Record<string, object>): {
  fetchFn: FetchFn;
  requests: { url: URL; authorization?: string }[];
} {
  const requests: { url: URL; authorization?: string }[] = [];
  const fetchFn = ((input: string, init: RequestInit) => {
    const url = new URL(input);
    requests.push({
      url,
      authorization: (init.headers as Record<string, string>).Authorization,
    });
    const body = routes[url.pathname];
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { message: 'Not found' }), {
        status: body ? 200 : 404,
      }),
    );
  }) as unknown as FetchFn;
  return { fetchFn, requests };
}

/** What FinStack makes of a delivery: signature check, then parsing. */
function received(
  adapter: PaymentProvider,
  delivery: Delivery,
): { verified: boolean; event: ProviderWebhookEvent } {
  const rawBody = Buffer.from(delivery.body);
  return {
    verified: adapter.verifyWebhookSignature(rawBody, delivery.headers),
    event: adapter.parseWebhookEvent(rawBody),
  };
}

const since = new Date('2026-10-01T09:00:00Z');

describe('PaystackSource', () => {
  it('turns finished transactions and transfers into webhooks FinStack accepts', async () => {
    const { fetchFn, requests } = fakeApi({
      '/transaction': {
        status: true,
        data: [
          {
            id: 3,
            reference: 'trx_3',
            status: 'failed',
            amount: 100,
            currency: 'NGN',
            createdAt: '2026-10-01T10:03:00Z',
          },
          {
            id: 2,
            reference: 'trx_2',
            status: 'ongoing',
            amount: 100,
            currency: 'NGN',
            createdAt: '2026-10-01T10:02:00Z',
          },
          {
            id: 1,
            reference: 'trx_1',
            status: 'success',
            amount: 500000,
            currency: 'NGN',
            createdAt: '2026-10-01T10:01:00Z',
          },
        ],
      },
      '/transfer': {
        status: true,
        data: [
          {
            id: 7,
            reference: 'pyt_1',
            transfer_code: 'TRF_1',
            status: 'success',
            amount: 100000,
            currency: 'NGN',
            createdAt: '2026-10-01T10:02:30Z',
          },
        ],
      },
    });
    const deliveries = await new PaystackSource(
      PAYSTACK_KEY,
      'https://api.paystack.test',
      fetchFn,
    ).poll(since);

    // Finished only, oldest first.
    expect(deliveries.map((d) => [d.type, d.reference])).toEqual([
      ['charge.success', 'trx_1'],
      ['transfer.success', 'pyt_1'],
      ['charge.failed', 'trx_3'],
    ]);
    expect(
      deliveries.map((d) => {
        const { verified, event } = received(adapters.paystack, d);
        return [verified, event.type, event.providerReference];
      }),
    ).toEqual([
      [true, 'payment.succeeded', 'trx_1'],
      [true, 'payout.succeeded', 'pyt_1'],
      [true, 'payment.failed', 'trx_3'],
    ]);
    expect(requests[0]?.url.searchParams.get('from')).toBe(since.toISOString());
    expect(requests[0]?.authorization).toBe(`Bearer ${PAYSTACK_KEY}`);
  });

  it('keys each delivery by record and status, so a status change is a new event', async () => {
    const api = (status: string): FetchFn =>
      fakeApi({
        '/transaction': {
          data: [
            { id: 1, reference: 'trx_1', status, amount: 1, currency: 'NGN' },
          ],
        },
        '/transfer': { data: [] },
      }).fetchFn;
    const source = (status: string): PaystackSource =>
      new PaystackSource(PAYSTACK_KEY, 'https://x', api(status));
    const [success] = await source('success').poll(since);
    const [again] = await source('success').poll(since);
    const [failed] = await source('failed').poll(since);
    expect(again?.key).toBe(success?.key);
    expect(failed?.key).not.toBe(success?.key);
  });
});

describe('FlutterwaveSource', () => {
  it('turns finished transactions and transfers into v3 webhooks FinStack accepts', async () => {
    const { fetchFn, requests } = fakeApi({
      '/v3/transactions': {
        status: 'success',
        data: [
          {
            id: 11,
            tx_ref: 'trx_1',
            status: 'successful',
            amount: 1200.75,
            currency: 'NGN',
            created_at: '2026-10-01T10:01:00Z',
          },
          {
            id: 12,
            tx_ref: 'trx_2',
            status: 'pending',
            amount: 1,
            currency: 'NGN',
            created_at: '2026-10-01T10:02:00Z',
          },
          // Created before `since`: Flutterwave filters by whole days.
          {
            id: 10,
            tx_ref: 'trx_0',
            status: 'successful',
            amount: 1,
            currency: 'NGN',
            created_at: '2026-10-01T08:00:00Z',
          },
        ],
      },
      '/v3/transfers': {
        status: 'success',
        data: [
          {
            id: 21,
            reference: 'pyt_1',
            status: 'FAILED',
            amount: 1000,
            currency: 'NGN',
            created_at: '2026-10-01T10:03:00Z',
          },
        ],
      },
    });
    const deliveries = await new FlutterwaveSource(
      FLW_KEY,
      FLW_HASH,
      'https://api.flutterwave.test/v3',
      fetchFn,
    ).poll(since);

    expect(
      deliveries.map((d) => {
        const { verified, event } = received(adapters.flutterwave, d);
        return [verified, event.type, event.providerReference];
      }),
    ).toEqual([
      [true, 'payment.succeeded', 'trx_1'],
      [true, 'payout.failed', 'pyt_1'],
    ]);
    expect(requests[0]?.url.searchParams.get('from')).toBe('2026-09-30');
  });
});

describe('StripeSource', () => {
  it("delivers Stripe's real events, oldest first, signed so FinStack accepts them", async () => {
    const event = (
      id: string,
      created: number,
      type: string,
      object: object,
    ): object => ({
      id,
      object: 'event',
      type,
      created,
      data: { object },
    });
    const { fetchFn, requests } = fakeApi({
      '/v1/events': {
        object: 'list',
        has_more: false,
        data: [
          event('evt_2', 1_790_870_000, 'refund.updated', {
            object: 'refund',
            id: 're_1',
            status: 'succeeded',
            metadata: { finstack_reference: 'rfd_1' },
          }),
          event('evt_1', 1_790_860_000, 'checkout.session.completed', {
            object: 'checkout.session',
            id: 'cs_1',
            client_reference_id: 'trx_1',
          }),
        ],
      },
    });
    const deliveries = await new StripeSource(
      STRIPE_KEY,
      STRIPE_SECRET,
      'https://api.stripe.test',
      fetchFn,
    ).poll(since);

    expect(deliveries.map((d) => [d.type, d.reference])).toEqual([
      ['checkout.session.completed', 'trx_1'],
      ['refund.updated', 'rfd_1'],
    ]);
    expect(
      deliveries.map((d) => {
        const { verified, event: parsed } = received(adapters.stripe, d);
        return [verified, parsed.eventId, parsed.type];
      }),
    ).toEqual([
      [true, 'evt_1', 'payment.succeeded'],
      [true, 'evt_2', 'refund.succeeded'],
    ]);
    const query = requests[0]?.url.searchParams;
    expect(query?.get('created[gte]')).toBe(String(since.getTime() / 1000));
    expect(query?.getAll('types[]')).toContain('checkout.session.completed');
  });

  it('is rejected by FinStack when signed with a different secret', async () => {
    const { fetchFn } = fakeApi({
      '/v1/events': {
        data: [
          {
            id: 'evt_1',
            type: 'checkout.session.completed',
            created: 1,
            data: { object: {} },
          },
        ],
      },
    });
    const [delivery] = await new StripeSource(
      STRIPE_KEY,
      'whsec_wrong',
      'https://x',
      fetchFn,
    ).poll(since);
    expect(received(adapters.stripe, delivery as Delivery).verified).toBe(
      false,
    );
  });
});
