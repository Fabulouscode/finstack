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

describe('PaystackProvider payouts', () => {
  /** Answers each call in order. */
  function providerAnswering(
    ...responses: { status: number; body: object }[]
  ): { provider: PaystackProvider; calls: Captured[] } {
    const calls: Captured[] = [];
    const fetchFn = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift() ?? { status: 500, body: {} };
      return Promise.resolve(
        new Response(JSON.stringify(next.body), { status: next.status }),
      );
    }) as unknown as FetchFn;
    return {
      provider: new PaystackProvider(config, new JsonHttpClient(fetchFn)),
      calls,
    };
  }

  const ok = (data: object): { status: number; body: object } => ({
    status: 200,
    body: { status: true, message: 'ok', data },
  });

  it('resolves Nigerian accounts and saves the verified name', async () => {
    const { provider, calls } = providerAnswering(
      ok({ account_name: 'ADA LOVELACE', account_number: '0123456789' }),
      ok({
        recipient_code: 'RCP_abc',
        name: 'ADA LOVELACE',
        details: { bank_name: 'Guaranty Trust Bank' },
      }),
    );

    const recipient = await provider.payouts.createRecipient({
      currency: 'NGN',
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'Someone Else',
    });

    expect(recipient).toEqual({
      recipientReference: 'RCP_abc',
      accountName: 'ADA LOVELACE',
      bankName: 'Guaranty Trust Bank',
    });
    expect(calls[0]?.url).toBe(
      'https://api.paystack.test/bank/resolve?account_number=0123456789&bank_code=058',
    );
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({
      type: 'nuban',
      name: 'ADA LOVELACE',
      account_number: '0123456789',
      bank_code: '058',
      currency: 'NGN',
    });
  });

  it('sends transfers with our reference and maps their status', async () => {
    const { provider, calls } = providerAnswering(
      ok({ transfer_code: 'TRF_1', reference: 'pyt_1', status: 'otp' }),
    );

    const result = await provider.payouts.initiate({
      reference: 'pyt_1',
      amount: 500000n,
      currency: 'NGN',
      recipientReference: 'RCP_abc',
      narration: 'Withdrawal',
    });

    expect(result).toEqual({ providerReference: 'TRF_1', status: 'pending' });
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      source: 'balance',
      amount: '500000',
      currency: 'NGN',
      recipient: 'RCP_abc',
      reference: 'pyt_1',
      reason: 'Withdrawal',
    });
  });

  it.each([
    ['success', 'successful'],
    ['failed', 'failed'],
    ['reversed', 'reversed'],
    ['processing', 'pending'],
  ])('looks transfers up by reference (%s -> %s)', async (status, mapped) => {
    const { provider, calls } = providerAnswering(
      ok({ transfer_code: 'TRF_1', reference: 'pyt_1', status }),
    );
    await expect(provider.payouts.find('pyt_1')).resolves.toMatchObject({
      status: mapped,
    });
    expect(calls[0]?.url).toBe(
      'https://api.paystack.test/transfer/verify/pyt_1',
    );
  });

  it('reports a transfer Paystack never received as not found', async () => {
    const { provider } = providerAnswering({
      status: 404,
      body: { status: false, message: 'Transfer not found' },
    });
    await expect(provider.payouts.find('pyt_1')).resolves.toBeNull();
  });

  it('does not treat other errors as "not found"', async () => {
    const { provider } = providerAnswering({ status: 503, body: {} });
    await expect(provider.payouts.find('pyt_1')).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('maps transfer webhooks to payout events carrying our reference', () => {
    const { provider } = providerAnswering();
    const event = provider.parseWebhookEvent(
      Buffer.from(
        JSON.stringify({
          event: 'transfer.reversed',
          data: { id: 77, reference: 'pyt_1', transfer_code: 'TRF_1' },
        }),
      ),
    );
    expect(event).toMatchObject({
      type: 'payout.reversed',
      providerReference: 'pyt_1',
    });
  });
});
