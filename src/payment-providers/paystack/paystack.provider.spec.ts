import { createHmac } from 'node:crypto';
import { paymentsConfigFixture } from '../../config/testing/payments-config.fixture';
import { FetchFn, JsonHttpClient } from '../http/json-http-client';
import { PaymentProviderError } from '../payment-provider';
import {
  PAYSTACK_SIGNATURE_HEADER,
  PaystackProvider,
} from './paystack.provider';

const SECRET = 'sk_test_unitsecret123';
const config = paymentsConfigFixture({
  enabledProviders: ['paystack'],
  defaultProvider: 'paystack',
  paystack: {
    secretKey: SECRET,
    baseUrl: 'https://api.paystack.test',
    timeoutMs: 5_000,
  },
});

interface Captured {
  url: string;
  init: RequestInit;
}

function providerReturning(
  status: number,
  body: object,
): {
  provider: PaystackProvider;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as FetchFn;
  return {
    provider: new PaystackProvider(config, new JsonHttpClient(fetchFn)),
    calls,
  };
}

const transaction = (overrides: object = {}): object => ({
  status: true,
  message: 'Verification successful',
  data: {
    id: 4099,
    reference: 'trx_1',
    status: 'success',
    amount: 1550000,
    currency: 'NGN',
    ...overrides,
  },
});

describe('PaystackProvider', () => {
  it('initialises with our reference, amount in subunits and the secret key', async () => {
    const { provider, calls } = providerReturning(200, {
      status: true,
      message: 'Authorization URL created',
      data: {
        authorization_url: 'https://checkout.paystack.com/abc',
        access_code: 'abc',
        reference: 'trx_1',
      },
    });

    const result = await provider.initializePayment({
      reference: 'trx_1',
      amount: 1_550_000n,
      currency: 'NGN',
      customerEmail: 'ada@example.com',
      callbackUrl: 'https://app.example.com/done',
    });

    expect(result).toEqual({
      providerReference: 'trx_1',
      authorizationUrl: 'https://checkout.paystack.com/abc',
    });
    expect(calls[0]?.url).toBe(
      'https://api.paystack.test/transaction/initialize',
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(
      (calls[0]?.init.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      email: 'ada@example.com',
      amount: '1550000',
      currency: 'NGN',
      reference: 'trx_1',
      callback_url: 'https://app.example.com/done',
    });
  });

  it.each([
    ['success', 'successful'],
    ['failed', 'failed'],
    ['abandoned', 'failed'],
    ['reversed', 'failed'],
    ['ongoing', 'pending'],
    ['pending', 'pending'],
    ['processing', 'pending'],
  ])('maps Paystack status %s to %s', async (paystackStatus, expected) => {
    const { provider } = providerReturning(
      200,
      transaction({ status: paystackStatus }),
    );

    await expect(
      provider.verifyPayment({
        reference: 'trx_1',
        providerReference: 'trx_1',
      }),
    ).resolves.toMatchObject({
      status: expected,
      amount: 1_550_000n,
      currency: 'NGN',
    });
  });

  it('refuses a verification response for a different transaction', async () => {
    const { provider } = providerReturning(
      200,
      transaction({ reference: 'trx_other' }),
    );

    await expect(
      provider.verifyPayment({
        reference: 'trx_1',
        providerReference: 'trx_1',
      }),
    ).rejects.toThrow(PaymentProviderError);
  });

  it('treats an unsuccessful envelope as a rejection', async () => {
    const { provider } = providerReturning(200, {
      status: false,
      message: 'Invalid key',
    });

    const error = await provider
      .verifyPayment({ reference: 'trx_1', providerReference: 'trx_1' })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      retryable: false,
      message: 'Paystack: Invalid key',
    });
  });

  it('maps refunds', async () => {
    const { provider } = providerReturning(200, {
      status: true,
      message: 'ok',
      data: { id: 77, status: 'pending' },
    });

    await expect(
      provider.refundPayment({
        providerReference: 'trx_1',
        amount: 500n,
        currency: 'NGN',
        reference: 'rf_1',
      }),
    ).resolves.toEqual({ providerRefundReference: '77', status: 'pending' });
  });

  it.each([
    ['processed', 'successful'],
    ['pending', 'pending'],
    ['processing', 'pending'],
    ['failed', 'failed'],
  ])('maps refund status %s to %s', async (paystackStatus, expected) => {
    const { provider, calls } = providerReturning(200, {
      status: true,
      message: 'Refund retrieved',
      data: { id: 77, status: paystackStatus },
    });

    await expect(provider.getRefund('77')).resolves.toEqual({
      providerRefundReference: '77',
      status: expected,
    });
    expect(calls[0]?.url).toBe('https://api.paystack.test/refund/77');
  });

  it('maps refund webhooks to the refunded payment reference', () => {
    const { provider } = providerReturning(200, {});
    const event = provider.parseWebhookEvent(
      Buffer.from(
        JSON.stringify({
          event: 'refund.processed',
          data: { id: 77, transaction_reference: 'trx_1', amount: 500 },
        }),
      ),
    );

    expect(event).toMatchObject({
      type: 'refund.succeeded',
      providerReference: 'trx_1',
      eventId: 'refund.processed:trx_1:500:77',
    });
  });

  describe('webhooks', () => {
    const { provider } = providerReturning(200, {});
    const body = Buffer.from(
      JSON.stringify({
        event: 'charge.success',
        data: { id: 4099, reference: 'trx_1', status: 'success' },
      }),
    );
    const sign = (raw: Buffer, secret = SECRET): string =>
      createHmac('sha512', secret).update(raw).digest('hex');

    it('accepts an HMAC-SHA512 signature over the raw body', () => {
      expect(
        provider.verifyWebhookSignature(body, {
          [PAYSTACK_SIGNATURE_HEADER]: sign(body),
        }),
      ).toBe(true);
    });

    it('rejects tampering, other secrets and malformed signatures', () => {
      const tampered = Buffer.from(body.toString().replace('4099', '4100'));

      expect(
        provider.verifyWebhookSignature(tampered, {
          [PAYSTACK_SIGNATURE_HEADER]: sign(body),
        }),
      ).toBe(false);
      expect(
        provider.verifyWebhookSignature(body, {
          [PAYSTACK_SIGNATURE_HEADER]: sign(body, 'sk_test_other'),
        }),
      ).toBe(false);
      expect(
        provider.verifyWebhookSignature(body, {
          [PAYSTACK_SIGNATURE_HEADER]: 'abc',
        }),
      ).toBe(false);
      expect(provider.verifyWebhookSignature(body, {})).toBe(false);
    });

    it('derives a stable event id for duplicate detection', () => {
      expect(provider.parseWebhookEvent(body)).toEqual({
        eventId: 'charge.success:4099',
        type: 'payment.succeeded',
        providerType: 'charge.success',
        providerReference: 'trx_1',
        reference: 'trx_1',
      });
    });
  });
});
