import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { paymentsConfigFixture } from '../../config/testing/payments-config.fixture';
import { FetchFn, JsonHttpClient } from '../http/json-http-client';
import { PaymentProviderError } from '../payment-provider';
import { PayPalProvider } from './paypal.provider';

// A self-signed certificate made for these tests only; it signs nothing real.
const TEST_CERT = readFileSync(
  join(__dirname, 'testing/webhook-test-cert.pem'),
  'utf8',
);
const TEST_KEY = readFileSync(
  join(__dirname, 'testing/webhook-test-key.pem'),
  'utf8',
);
const CERT_URL =
  'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test';
const WEBHOOK_ID = 'WH-unit-test';

const config = paymentsConfigFixture({
  enabledProviders: ['paypal'],
  defaultProvider: 'paypal',
  paypal: {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    webhookId: WEBHOOK_ID,
    baseUrl: 'https://api-m.sandbox.paypal.test',
    timeoutMs: 5_000,
    webhookToleranceSeconds: 300,
    returnUrl: 'https://app.example.com/paid',
    cancelUrl: 'https://app.example.com/cancelled',
  },
});

interface Captured {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = object | { status: number; body: object };

/** Answers each non-token request with the next reply; the OAuth token call is answered automatically. */
function providerReturning(...replies: Reply[]): {
  provider: PayPalProvider;
  calls: Captured[];
  tokens: () => number;
} {
  const calls: Captured[] = [];
  let tokens = 0;
  const fetchFn = ((url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/v1/oauth2/token') {
      tokens++;
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: 'token-1', expires_in: 32400 }),
          { status: 200 },
        ),
      );
    }
    calls.push({
      method: String(init.method),
      path,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {};
    const { status, body } =
      'status' in reply && 'body' in reply
        ? reply
        : { status: 200, body: reply };
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as FetchFn;
  return {
    provider: new PayPalProvider(config, new JsonHttpClient(fetchFn)),
    calls,
    tokens: () => tokens,
  };
}

const order = (overrides: object = {}): object => ({
  id: 'ORDER-1',
  status: 'COMPLETED',
  purchase_units: [
    {
      reference_id: 'trx_1',
      amount: { currency_code: 'USD', value: '10.00' },
      payments: {
        captures: [
          {
            id: 'CAPTURE-1',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '10.00' },
          },
        ],
      },
    },
  ],
  ...overrides,
});

describe('PayPalProvider', () => {
  it('creates an order, idempotent by our reference, and returns the approval link', async () => {
    const { provider, calls } = providerReturning({
      id: 'ORDER-1',
      status: 'PAYER_ACTION_REQUIRED',
      links: [
        {
          rel: 'payer-action',
          href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1',
        },
      ],
    });

    const result = await provider.initializePayment({
      reference: 'trx_1',
      amount: 1_050n,
      currency: 'USD',
      customerEmail: 'ada@example.com',
    });

    expect(result).toEqual({
      providerReference: 'ORDER-1',
      authorizationUrl:
        'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1',
    });
    const [call] = calls;
    expect(call?.path).toBe('/v2/checkout/orders');
    expect(call?.headers['PayPal-Request-Id']).toBe('finstack-init-trx_1');
    expect(call?.headers.Authorization).toBe('Bearer token-1');
    expect(call?.body).toMatchObject({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: 'trx_1',
          custom_id: 'trx_1',
          amount: { currency_code: 'USD', value: '10.50' },
        },
      ],
    });
  });

  it('reuses its access token until it expires', async () => {
    const { provider, tokens } = providerReturning(order(), order());
    await provider.verifyPayment({
      reference: 'trx_1',
      providerReference: 'ORDER-1',
    });
    await provider.verifyPayment({
      reference: 'trx_1',
      providerReference: 'ORDER-1',
    });
    expect(tokens()).toBe(1);
  });

  it('captures an approved order exactly once and reports what was collected', async () => {
    const { provider, calls } = providerReturning(
      order({
        status: 'APPROVED',
        purchase_units: [{ reference_id: 'trx_1' }],
      }),
      order(),
    );

    const result = await provider.verifyPayment({
      reference: 'trx_1',
      providerReference: 'ORDER-1',
    });

    expect(result).toEqual({
      status: 'successful',
      providerReference: 'ORDER-1',
      amount: 1_000n,
      currency: 'USD',
    });
    expect(calls[1]?.path).toBe('/v2/checkout/orders/ORDER-1/capture');
    expect(calls[1]?.headers['PayPal-Request-Id']).toBe(
      'finstack-capture-trx_1',
    );
  });

  it('reads the order again when the capture is refused (already captured elsewhere)', async () => {
    const { provider, calls } = providerReturning(
      order({
        status: 'APPROVED',
        purchase_units: [{ reference_id: 'trx_1' }],
      }),
      {
        status: 422,
        body: {
          name: 'UNPROCESSABLE_ENTITY',
          details: [{ issue: 'ORDER_ALREADY_CAPTURED' }],
        },
      },
      order(),
    );

    const result = await provider.verifyPayment({
      reference: 'trx_1',
      providerReference: 'ORDER-1',
    });

    expect(result.status).toBe('successful');
    expect(calls.map((call) => call.path)).toEqual([
      '/v2/checkout/orders/ORDER-1',
      '/v2/checkout/orders/ORDER-1/capture',
      '/v2/checkout/orders/ORDER-1',
    ]);
  });

  it('refuses an order created for another payment', async () => {
    const { provider } = providerReturning(order());
    await expect(
      provider.verifyPayment({
        reference: 'trx_other',
        providerReference: 'ORDER-1',
      }),
    ).rejects.toMatchObject({
      retryable: false,
    });
  });

  it.each([
    ['PAYER_ACTION_REQUIRED', undefined, 'pending'],
    ['COMPLETED', 'PENDING', 'pending'],
    ['COMPLETED', 'DECLINED', 'failed'],
    ['COMPLETED', 'REFUNDED', 'successful'],
    ['VOIDED', undefined, 'failed'],
  ])(
    'maps order %s / capture %s to %s',
    async (orderStatus, captureStatus, expected) => {
      const unit = {
        reference_id: 'trx_1',
        amount: { currency_code: 'USD', value: '10.00' },
        ...(captureStatus
          ? {
              payments: {
                captures: [
                  {
                    id: 'C',
                    status: captureStatus,
                    amount: { currency_code: 'USD', value: '10.00' },
                  },
                ],
              },
            }
          : {}),
      };
      const { provider } = providerReturning(
        order({ status: orderStatus, purchase_units: [unit] }),
      );
      const result = await provider.verifyPayment({
        reference: 'trx_1',
        providerReference: 'ORDER-1',
      });
      expect(result.status).toBe(expected);
    },
  );

  it('converts zero-decimal currencies exactly', async () => {
    const { provider } = providerReturning(
      order({
        purchase_units: [
          {
            reference_id: 'trx_1',
            payments: {
              captures: [
                {
                  id: 'C',
                  status: 'COMPLETED',
                  amount: { currency_code: 'JPY', value: '500' },
                },
              ],
            },
          },
        ],
      }),
    );
    const result = await provider.verifyPayment({
      reference: 'trx_1',
      providerReference: 'ORDER-1',
    });
    expect(result).toMatchObject({ amount: 500n, currency: 'JPY' });
  });

  it('refunds the order’s capture, tagged and idempotent by our refund reference', async () => {
    const { provider, calls } = providerReturning(order(), {
      id: 'REFUND-1',
      status: 'COMPLETED',
    });

    const result = await provider.refundPayment({
      providerReference: 'ORDER-1',
      amount: 250n,
      currency: 'USD',
      reference: 'rfd_1',
    });

    expect(result).toEqual({
      providerRefundReference: 'REFUND-1',
      status: 'successful',
    });
    expect(calls[1]?.path).toBe('/v2/payments/captures/CAPTURE-1/refund');
    expect(calls[1]?.headers['PayPal-Request-Id']).toBe(
      'finstack-refund-rfd_1',
    );
    expect(calls[1]?.body).toEqual({
      amount: { currency_code: 'USD', value: '2.50' },
      custom_id: 'rfd_1',
    });
  });

  it('finds our refund by its custom_id, fetching details PayPal left out', async () => {
    const withRefunds = order({
      purchase_units: [
        {
          reference_id: 'trx_1',
          payments: {
            refunds: [
              { id: 'R-other', status: 'COMPLETED' },
              { id: 'R-ours', status: 'PENDING' },
            ],
          },
        },
      ],
    });
    const { provider } = providerReturning(
      withRefunds,
      { id: 'R-other', status: 'COMPLETED', custom_id: 'rfd_someone_else' },
      { id: 'R-ours', status: 'PENDING', custom_id: 'rfd_1' },
    );

    await expect(
      provider.findRefund({ providerReference: 'ORDER-1', reference: 'rfd_1' }),
    ).resolves.toEqual({
      providerRefundReference: 'R-ours',
      status: 'pending',
    });
  });

  it('reports no refund when PayPal has none of ours', async () => {
    const { provider } = providerReturning(order());
    await expect(
      provider.findRefund({ providerReference: 'ORDER-1', reference: 'rfd_1' }),
    ).resolves.toBeNull();
  });

  it('treats an unreachable PayPal as retryable', async () => {
    const { provider } = providerReturning({
      status: 503,
      body: { name: 'SERVICE_UNAVAILABLE' },
    });
    const attempt = provider.verifyPayment({
      reference: 'trx_1',
      providerReference: 'ORDER-1',
    });
    await expect(attempt).rejects.toBeInstanceOf(PaymentProviderError);
    await expect(attempt).rejects.toMatchObject({ retryable: true });
  });

  describe('webhooks', () => {
    const body = Buffer.from(
      JSON.stringify({
        id: 'WH-EVT-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAPTURE-1',
          custom_id: 'trx_1',
          supplementary_data: { related_ids: { order_id: 'ORDER-1' } },
        },
      }),
    );

    function signedHeaders(
      raw: Buffer,
      overrides: Record<string, string> = {},
      webhookId = WEBHOOK_ID,
    ): Record<string, string> {
      const transmissionId = 'b2384410-f8d2-11e8-8e34-test';
      const transmissionTime = new Date().toISOString();
      const signature = createSign('RSA-SHA256')
        .update(
          `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(raw)}`,
        )
        .sign(TEST_KEY, 'base64');
      return {
        'paypal-transmission-id': transmissionId,
        'paypal-transmission-time': transmissionTime,
        'paypal-transmission-sig': signature,
        'paypal-cert-url': CERT_URL,
        'paypal-auth-algo': 'SHA256withRSA',
        ...overrides,
      };
    }

    let certDownloads: string[];
    beforeEach(() => {
      certDownloads = [];
      jest.spyOn(global, 'fetch').mockImplementation((url) => {
        certDownloads.push(url instanceof Request ? url.url : url.toString());
        return Promise.resolve(new Response(TEST_CERT, { status: 200 }));
      });
    });
    afterEach(() => jest.restoreAllMocks());

    it('accepts a delivery signed for our webhook, and downloads the certificate once', async () => {
      const { provider } = providerReturning();
      await expect(
        provider.verifyWebhookSignature(body, signedHeaders(body)),
      ).resolves.toBe(true);
      await expect(
        provider.verifyWebhookSignature(body, signedHeaders(body)),
      ).resolves.toBe(true);
      expect(certDownloads).toEqual([CERT_URL]);
    });

    it('rejects a changed body', async () => {
      const { provider } = providerReturning();
      const headers = signedHeaders(body);
      await expect(
        provider.verifyWebhookSignature(
          Buffer.from(`${body.toString()} `),
          headers,
        ),
      ).resolves.toBe(false);
    });

    it('rejects a delivery signed for another webhook', async () => {
      const { provider } = providerReturning();
      await expect(
        provider.verifyWebhookSignature(
          body,
          signedHeaders(body, {}, 'WH-someone-else'),
        ),
      ).resolves.toBe(false);
    });

    it('rejects a certificate that is not from paypal.com, without downloading it', async () => {
      const { provider } = providerReturning();
      const headers = signedHeaders(body, {
        'paypal-cert-url': 'https://evil.example.com/cert.pem',
      });
      await expect(
        provider.verifyWebhookSignature(body, headers),
      ).resolves.toBe(false);
      expect(certDownloads).toEqual([]);
    });

    it('rejects an old delivery (replay)', async () => {
      const { provider } = providerReturning();
      const headers = signedHeaders(body, {
        'paypal-transmission-time': '2020-01-01T00:00:00Z',
      });
      await expect(
        provider.verifyWebhookSignature(body, headers),
      ).resolves.toBe(false);
    });

    it.each([
      [
        'PAYMENT.CAPTURE.COMPLETED',
        {
          custom_id: 'trx_1',
          supplementary_data: { related_ids: { order_id: 'ORDER-1' } },
        },
        {
          type: 'payment.succeeded',
          providerReference: 'ORDER-1',
          reference: 'trx_1',
        },
      ],
      [
        'PAYMENT.CAPTURE.DENIED',
        {
          custom_id: 'trx_1',
          supplementary_data: { related_ids: { order_id: 'ORDER-1' } },
        },
        { type: 'payment.failed', providerReference: 'ORDER-1' },
      ],
      [
        'CHECKOUT.ORDER.APPROVED',
        { id: 'ORDER-1', purchase_units: [{ reference_id: 'trx_1' }] },
        {
          type: 'payment.approved',
          providerReference: 'ORDER-1',
          reference: 'trx_1',
        },
      ],
      [
        'PAYMENT.CAPTURE.REFUNDED',
        { id: 'REFUND-1', custom_id: 'rfd_1' },
        {
          type: 'refund.succeeded',
          providerReference: 'rfd_1',
          reference: 'rfd_1',
        },
      ],
      [
        'BILLING.SUBSCRIPTION.CREATED',
        { id: 'I-1' },
        { type: 'unknown', providerReference: undefined },
      ],
    ])('parses %s', (eventType, resource, expected) => {
      const { provider } = providerReturning();
      const event = provider.parseWebhookEvent(
        Buffer.from(
          JSON.stringify({ id: 'WH-1', event_type: eventType, resource }),
        ),
      );
      expect(event).toMatchObject({
        eventId: 'WH-1',
        providerType: eventType,
        ...expected,
      });
    });
  });
});
