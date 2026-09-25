import { createHmac } from 'node:crypto';
import { paymentsConfigFixture } from '../../config/testing/payments-config.fixture';
import { FetchFn, JsonHttpClient } from '../http/json-http-client';
import { PaymentProviderError } from '../payment-provider';
import { STRIPE_SIGNATURE_HEADER, StripeProvider } from './stripe.provider';

const WEBHOOK_SECRET = 'whsec_unittestsecret';
const config = paymentsConfigFixture({
  enabledProviders: ['stripe'],
  defaultProvider: 'stripe',
  stripe: {
    secretKey: 'sk_test_unit123',
    webhookSecret: WEBHOOK_SECRET,
    baseUrl: 'https://api.stripe.test',
    timeoutMs: 5_000,
    webhookToleranceSeconds: 300,
    successUrl: 'https://app.example.com/paid',
    cancelUrl: 'https://app.example.com/cancelled',
  },
});

interface Captured {
  url: string;
  init: RequestInit;
}

function providerReturning(...responses: object[]): {
  provider: StripeProvider;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = responses[Math.min(calls.length - 1, responses.length - 1)];
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as unknown as FetchFn;
  return {
    provider: new StripeProvider(config, new JsonHttpClient(fetchFn)),
    calls,
  };
}

const session = (overrides: object = {}): object => ({
  id: 'cs_test_123',
  url: 'https://checkout.stripe.com/c/pay/cs_test_123',
  client_reference_id: 'trx_1',
  status: 'complete',
  payment_status: 'paid',
  amount_total: 1000,
  currency: 'usd',
  payment_intent: 'pi_123',
  ...overrides,
});

describe('StripeProvider', () => {
  it('creates a Checkout Session, idempotent by our reference', async () => {
    const { provider, calls } = providerReturning(
      session({ status: 'open', payment_status: 'unpaid' }),
    );

    const result = await provider.initializePayment({
      reference: 'trx_1',
      amount: 1_000n,
      currency: 'USD',
      customerEmail: 'ada@example.com',
    });

    expect(result).toEqual({
      providerReference: 'cs_test_123',
      authorizationUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
    });
    const [call] = calls;
    expect(call?.url).toBe('https://api.stripe.test/v1/checkout/sessions');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers['Idempotency-Key']).toBe('finstack-init-trx_1');
    expect(headers.Authorization).toBe('Bearer sk_test_unit123');
    const form = new URLSearchParams(call?.init.body as string);
    expect(Object.fromEntries(form)).toMatchObject({
      mode: 'payment',
      client_reference_id: 'trx_1',
      success_url: 'https://app.example.com/paid',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '1000',
    });
  });

  it.each([
    [{ status: 'complete', payment_status: 'paid' }, 'successful'],
    [{ status: 'complete', payment_status: 'unpaid' }, 'pending'],
    [{ status: 'open', payment_status: 'unpaid' }, 'pending'],
    [{ status: 'expired', payment_status: 'unpaid' }, 'failed'],
  ])('maps session %p to %s', async (state, expected) => {
    const { provider } = providerReturning(session(state));

    await expect(
      provider.verifyPayment({
        reference: 'trx_1',
        providerReference: 'cs_test_123',
      }),
    ).resolves.toMatchObject({
      status: expected,
      amount: 1_000n,
      currency: 'USD',
    });
  });

  it('refuses a session that belongs to another payment', async () => {
    const { provider } = providerReturning(
      session({ client_reference_id: 'trx_other' }),
    );

    await expect(
      provider.verifyPayment({
        reference: 'trx_1',
        providerReference: 'cs_test_123',
      }),
    ).rejects.toThrow(PaymentProviderError);
  });

  it('refunds through the session’s PaymentIntent', async () => {
    const { provider, calls } = providerReturning(session(), {
      id: 're_1',
      status: 'succeeded',
    });

    await expect(
      provider.refundPayment({
        providerReference: 'cs_test_123',
        amount: 400n,
        currency: 'USD',
        reference: 'rf_1',
      }),
    ).resolves.toEqual({
      providerRefundReference: 're_1',
      status: 'successful',
    });
    expect(
      Object.fromEntries(new URLSearchParams(calls[1]?.init.body as string)),
    ).toMatchObject({
      payment_intent: 'pi_123',
      amount: '400',
    });
  });

  it('reads a refund and maps refund events via our metadata reference', async () => {
    const { provider } = providerReturning({ id: 're_1', status: 'pending' });
    await expect(provider.getRefund('re_1')).resolves.toEqual({
      providerRefundReference: 're_1',
      status: 'pending',
    });

    const refundEvent = (status: string): Buffer =>
      Buffer.from(
        JSON.stringify({
          id: 'evt_r',
          type: 'refund.updated',
          data: {
            object: {
              id: 're_1',
              object: 'refund',
              status,
              metadata: { finstack_reference: 'rfd_1' },
            },
          },
        }),
      );
    expect(provider.parseWebhookEvent(refundEvent('succeeded'))).toMatchObject({
      type: 'refund.succeeded',
      providerReference: 'rfd_1',
    });
    expect(provider.parseWebhookEvent(refundEvent('failed')).type).toBe(
      'refund.failed',
    );
    expect(provider.parseWebhookEvent(refundEvent('pending')).type).toBe(
      'unknown',
    );
  });

  describe('webhook signatures', () => {
    const { provider } = providerReturning({});
    const body = Buffer.from(
      JSON.stringify({
        id: 'evt_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_123',
            object: 'checkout.session',
            client_reference_id: 'trx_1',
          },
        },
      }),
    );
    const now = (): number => Math.floor(Date.now() / 1000);
    const sign = (raw: Buffer, t: number, secret = WEBHOOK_SECRET): string =>
      createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
    const header = (value: string): Record<string, string> => ({
      [STRIPE_SIGNATURE_HEADER]: value,
    });

    it('accepts a fresh signature', () => {
      const t = now();
      expect(
        provider.verifyWebhookSignature(
          body,
          header(`t=${t},v1=${sign(body, t)}`),
        ),
      ).toBe(true);
    });

    it('accepts when any of several v1 signatures matches (secret rotation)', () => {
      const t = now();
      const stale = sign(body, t, 'whsec_oldsecret');
      expect(
        provider.verifyWebhookSignature(
          body,
          header(`t=${t},v1=${stale},v1=${sign(body, t)}`),
        ),
      ).toBe(true);
    });

    it('rejects a correctly signed but old webhook (replay protection)', () => {
      const t = now() - 301;
      expect(
        provider.verifyWebhookSignature(
          body,
          header(`t=${t},v1=${sign(body, t)}`),
        ),
      ).toBe(false);
    });

    it('rejects tampered bodies, a changed timestamp, other secrets and malformed headers', () => {
      const t = now();
      const valid = sign(body, t);
      const tampered = Buffer.from(body.toString().replace('trx_1', 'trx_2'));

      expect(
        provider.verifyWebhookSignature(tampered, header(`t=${t},v1=${valid}`)),
      ).toBe(false);
      expect(
        provider.verifyWebhookSignature(body, header(`t=${t + 1},v1=${valid}`)),
      ).toBe(false);
      expect(
        provider.verifyWebhookSignature(
          body,
          header(`t=${t},v1=${sign(body, t, 'whsec_x')}`),
        ),
      ).toBe(false);
      expect(provider.verifyWebhookSignature(body, header(`v1=${valid}`))).toBe(
        false,
      );
      expect(provider.verifyWebhookSignature(body, header(`t=${t}`))).toBe(
        false,
      );
      expect(provider.verifyWebhookSignature(body, {})).toBe(false);
    });

    it('maps Checkout Session events and ignores others', () => {
      expect(provider.parseWebhookEvent(body)).toEqual({
        eventId: 'evt_1',
        type: 'payment.succeeded',
        providerType: 'checkout.session.completed',
        providerReference: 'cs_test_123',
        reference: 'trx_1',
      });

      const expired = Buffer.from(
        JSON.stringify({
          id: 'evt_2',
          type: 'checkout.session.expired',
          data: { object: { id: 'cs_1', object: 'checkout.session' } },
        }),
      );
      const other = Buffer.from(
        JSON.stringify({
          id: 'evt_3',
          type: 'charge.succeeded',
          data: { object: { id: 'ch_1', object: 'charge' } },
        }),
      );
      expect(provider.parseWebhookEvent(expired).type).toBe('payment.failed');
      expect(provider.parseWebhookEvent(other)).toMatchObject({
        type: 'unknown',
        providerReference: undefined,
      });
    });
  });
});
