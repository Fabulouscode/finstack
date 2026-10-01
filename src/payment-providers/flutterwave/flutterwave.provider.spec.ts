import { paymentsConfigFixture } from '../../config/testing/payments-config.fixture';
import { FetchFn, JsonHttpClient } from '../http/json-http-client';
import {
  PaymentProviderError,
  PayoutRecipient,
  ProviderWebhookEvent,
} from '../payment-provider';
import {
  FLUTTERWAVE_SIGNATURE_HEADER,
  FlutterwaveProvider,
} from './flutterwave.provider';

const SECRET = 'FLWSECK_TEST-unitsecret123-X';
const HASH = 'unit-test-webhook-secret-hash';
const config = paymentsConfigFixture({
  enabledProviders: ['flutterwave'],
  defaultProvider: 'flutterwave',
  flutterwave: {
    secretKey: SECRET,
    webhookSecretHash: HASH,
    baseUrl: 'https://api.flutterwave.test/v3',
    timeoutMs: 5_000,
    redirectUrl: 'https://app.example.com/paid',
  },
});

interface Captured {
  url: string;
  method: string;
  body: unknown;
  authorization: string | undefined;
}

/** A provider whose HTTP calls get these responses, in order. */
function providerWith(...responses: [number, object][]): {
  provider: FlutterwaveProvider;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? (JSON.parse(init.body as string) as unknown) : null,
      authorization: (init.headers as Record<string, string>).Authorization,
    });
    const [status, body] = responses.shift() ?? [500, {}];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as FetchFn;
  return {
    provider: new FlutterwaveProvider(config, new JsonHttpClient(fetchFn)),
    calls,
  };
}

const ok = (data: unknown, meta?: object): [number, object] => [
  200,
  { status: 'success', message: 'ok', data, ...(meta ? { meta } : {}) },
];

const transaction = (overrides: object = {}): object => ({
  id: 3091255,
  tx_ref: 'trx_1',
  flw_ref: 'FLW-MOCK-1',
  amount: 15500,
  charged_amount: 15717,
  currency: 'NGN',
  status: 'successful',
  processor_response: 'Approved',
  created_at: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

describe('FlutterwaveProvider', () => {
  describe('payments', () => {
    it('creates a hosted checkout in major units, with our reference as tx_ref', async () => {
      const { provider, calls } = providerWith(
        ok({ link: 'https://checkout.flutterwave.com/v3/hosted/pay/abc' }),
      );

      const result = await provider.initializePayment({
        reference: 'trx_1',
        amount: 1_550_050n,
        currency: 'NGN',
        customerEmail: 'ada@example.com',
      });

      expect(result).toEqual({
        providerReference: 'trx_1',
        authorizationUrl: 'https://checkout.flutterwave.com/v3/hosted/pay/abc',
      });
      expect(calls[0]).toEqual({
        url: 'https://api.flutterwave.test/v3/payments',
        method: 'POST',
        authorization: `Bearer ${SECRET}`,
        body: {
          tx_ref: 'trx_1',
          amount: 15500.5,
          currency: 'NGN',
          redirect_url: 'https://app.example.com/paid',
          customer: { email: 'ada@example.com' },
        },
      });
    });

    it("uses the payment's own callback URL when given", async () => {
      const { provider, calls } = providerWith(ok({ link: 'https://x' }));
      await provider.initializePayment({
        reference: 'trx_1',
        amount: 500n,
        currency: 'USD',
        customerEmail: 'ada@example.com',
        callbackUrl: 'https://shop.example.com/done',
      });
      expect(calls[0]?.body).toMatchObject({
        amount: 5,
        redirect_url: 'https://shop.example.com/done',
      });
    });

    it('verifies by tx_ref and converts the collected amount back to minor units', async () => {
      const { provider, calls } = providerWith(ok(transaction()));

      await expect(
        provider.verifyPayment({
          reference: 'trx_1',
          providerReference: 'trx_1',
        }),
      ).resolves.toEqual({
        status: 'successful',
        providerReference: 'trx_1',
        // `amount`, not `charged_amount` (which includes customer fees).
        amount: 1_550_000n,
        currency: 'NGN',
      });
      expect(calls[0]?.url).toBe(
        'https://api.flutterwave.test/v3/transactions/verify_by_reference?tx_ref=trx_1',
      );
    });

    it('converts fractional amounts exactly', async () => {
      const { provider } = providerWith(
        ok(transaction({ amount: 99.95, currency: 'USD' })),
      );
      const result = await provider.verifyPayment({
        reference: 'trx_1',
        providerReference: 'trx_1',
      });
      expect(result.amount).toBe(9_995n);
    });

    it.each([
      ['failed', 'failed'],
      ['cancelled', 'failed'],
      ['pending', 'pending'],
      ['successful', 'successful'],
    ])('maps transaction status %s to %s', async (flutterwave, finstack) => {
      const { provider } = providerWith(
        ok(transaction({ status: flutterwave })),
      );
      const result = await provider.verifyPayment({
        reference: 'trx_1',
        providerReference: 'trx_1',
      });
      expect(result.status).toBe(finstack);
    });

    it('reports why a failed payment failed', async () => {
      const { provider } = providerWith(
        ok(
          transaction({
            status: 'failed',
            processor_response: 'Insufficient funds',
          }),
        ),
      );
      await expect(
        provider.verifyPayment({
          reference: 'trx_1',
          providerReference: 'trx_1',
        }),
      ).resolves.toMatchObject({ failureReason: 'Insufficient funds' });
    });

    it('refuses a verification for a different transaction', async () => {
      const { provider } = providerWith(ok(transaction({ tx_ref: 'trx_2' })));
      await expect(
        provider.verifyPayment({
          reference: 'trx_1',
          providerReference: 'trx_1',
        }),
      ).rejects.toThrow('Flutterwave returned a different transaction');
    });
  });

  describe('refunds', () => {
    it("looks up Flutterwave's transaction id, then refunds in major units", async () => {
      const { provider, calls } = providerWith(
        ok(transaction()),
        ok({ id: 75923, amount_refunded: 50, status: 'completed' }),
      );

      await expect(
        provider.refundPayment({
          providerReference: 'trx_1',
          amount: 5_000n,
          currency: 'NGN',
          reference: 'rfd_1',
        }),
      ).resolves.toEqual({
        providerRefundReference: '75923',
        status: 'successful',
      });
      expect(calls[1]).toMatchObject({
        url: 'https://api.flutterwave.test/v3/transactions/3091255/refund',
        method: 'POST',
        body: { amount: 50, comments: 'rfd_1' },
      });
    });

    it.each([
      ['completed', 'successful'],
      ['completed-mpgs', 'successful'],
      ['completed-bank-transfer', 'successful'],
      ['processing', 'pending'],
      ['pending-momo', 'pending'],
      ['failed', 'failed'],
    ])('maps refund status %s to %s', async (flutterwave, finstack) => {
      const { provider, calls } = providerWith(
        ok({ id: 75923, status: flutterwave }),
      );
      await expect(provider.getRefund('75923')).resolves.toEqual({
        providerRefundReference: '75923',
        status: finstack,
      });
      expect(calls[0]?.url).toBe(
        'https://api.flutterwave.test/v3/refunds/75923',
      );
    });
  });

  describe('webhooks', () => {
    const { provider } = providerWith();
    const verify = (hash: string | undefined): boolean =>
      provider.verifyWebhookSignature(
        Buffer.from('{}'),
        hash === undefined ? {} : { [FLUTTERWAVE_SIGNATURE_HEADER]: hash },
      );

    it('accepts only the exact secret hash', () => {
      expect(verify(HASH)).toBe(true);
      expect(verify(`${HASH}x`)).toBe(false);
      expect(verify(HASH.slice(0, -1))).toBe(false);
      expect(verify('')).toBe(false);
      expect(verify(undefined)).toBe(false);
    });

    const parse = (body: object): ProviderWebhookEvent =>
      provider.parseWebhookEvent(Buffer.from(JSON.stringify(body)));

    it('maps charge.completed to payment events keyed by our tx_ref', () => {
      expect(
        parse({
          event: 'charge.completed',
          data: { id: 285959875, tx_ref: 'trx_1', status: 'successful' },
        }),
      ).toEqual({
        eventId: 'charge.completed:285959875:successful',
        type: 'payment.succeeded',
        providerType: 'charge.completed',
        providerReference: 'trx_1',
        reference: 'trx_1',
      });
      expect(
        parse({
          event: 'charge.completed',
          data: { id: 1, tx_ref: 'trx_1', status: 'failed' },
        }).type,
      ).toBe('payment.failed');
    });

    it('maps transfer.completed to payout events keyed by our payout reference', () => {
      expect(
        parse({
          event: 'transfer.completed',
          'event.type': 'Transfer',
          data: { id: 33286, status: 'SUCCESSFUL', reference: 'pyt_1' },
        }),
      ).toEqual({
        eventId: 'transfer.completed:33286:SUCCESSFUL',
        type: 'payout.succeeded',
        providerType: 'transfer.completed',
        providerReference: 'pyt_1',
        reference: 'pyt_1',
      });
      expect(
        parse({
          event: 'transfer.completed',
          data: { id: 33286, status: 'FAILED', reference: 'pyt_1' },
        }).type,
      ).toBe('payout.failed');
    });

    // The older format, which accounts receive unless "v3 webhooks" is
    // enabled. Shape taken from a real test-mode delivery.
    const legacyCharge = {
      id: 10525521,
      txRef: 'trx_1',
      flwRef: 'FLW-MOCK-1cdb675511c3c8aed2599c6855862485',
      orderRef: 'URF_1790875018828_2160935',
      amount: 1200.75,
      charged_amount: 1200.75,
      status: 'successful',
      currency: 'NGN',
      'event.type': 'CARD_TRANSACTION',
      entity: { card6: '553188', card_last4: '2950' },
    };

    it('reads the older webhook format too', () => {
      expect(parse(legacyCharge)).toEqual({
        eventId: 'charge.completed:10525521:successful',
        type: 'payment.succeeded',
        providerType: 'CARD_TRANSACTION',
        providerReference: 'trx_1',
        reference: 'trx_1',
      });
      expect(parse({ ...legacyCharge, status: 'failed' }).type).toBe(
        'payment.failed',
      );
      expect(
        parse({
          'event.type': 'Transfer',
          transfer: { id: 33286, reference: 'pyt_1', status: 'FAILED' },
        }),
      ).toMatchObject({
        eventId: 'transfer.completed:33286:FAILED',
        type: 'payout.failed',
        providerReference: 'pyt_1',
      });
    });

    it('gives a charge the same event id in either format, so it is processed once', () => {
      const v3 = parse({
        event: 'charge.completed',
        data: { id: 10525521, tx_ref: 'trx_1', status: 'successful' },
      });
      expect(parse(legacyCharge).eventId).toBe(v3.eventId);
    });

    it('stores refund webhooks (no event name) as unhandled, with a stable id', () => {
      const refund = {
        id: 99025,
        AmountRefunded: 100,
        status: 'completed',
        TransactionId: 9231836,
      };
      const first = parse(refund);
      expect(first).toMatchObject({ type: 'unknown', providerType: 'unnamed' });
      expect(parse(refund).eventId).toBe(first.eventId);
      expect(parse({ ...refund, status: 'failed' }).eventId).not.toBe(
        first.eventId,
      );
    });
  });

  describe('payouts', () => {
    it('resolves the account name, then saves a beneficiary', async () => {
      const { provider, calls } = providerWith(
        ok({ account_number: '0690000034', account_name: 'ADE BOND' }),
        ok({
          id: 3644,
          account_number: '0690000034',
          bank_code: '044',
          full_name: 'ADE BOND',
          bank_name: 'ACCESS BANK NIGERIA',
        }),
      );

      await expect(
        provider.payouts.createRecipient({
          currency: 'NGN',
          bankCode: '044',
          accountNumber: '0690000034',
          accountName: 'Typed In Name',
        }),
      ).resolves.toEqual({
        recipientReference: '3644',
        accountName: 'ADE BOND',
        bankName: 'ACCESS BANK NIGERIA',
      });
      expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
        [
          'POST',
          'https://api.flutterwave.test/v3/accounts/resolve',
          { account_number: '0690000034', account_bank: '044' },
        ],
        [
          'POST',
          'https://api.flutterwave.test/v3/beneficiaries',
          {
            account_bank: '044',
            account_number: '0690000034',
            beneficiary_name: 'ADE BOND',
            currency: 'NGN',
          },
        ],
      ]);
    });

    const resolvedAda = ok({
      account_number: '0690000034',
      account_name: 'ADE BOND',
    });
    const alreadyAdded: [number, object] = [
      400,
      {
        status: 'error',
        message: 'Beneficiary already added to your account',
        data: null,
      },
    ];
    const addAda = (provider: FlutterwaveProvider): Promise<PayoutRecipient> =>
      provider.payouts.createRecipient({
        currency: 'NGN',
        bankCode: '044',
        accountNumber: '0690000034',
      });

    it('reuses the beneficiary Flutterwave already has for the account', async () => {
      const { provider, calls } = providerWith(
        resolvedAda,
        alreadyAdded,
        ok(
          [
            {
              id: 1,
              account_number: '0690000034',
              bank_code: '058',
              full_name: 'Same number, other bank',
            },
          ],
          { page_info: { current_page: 1, total_pages: 2 } },
        ),
        ok(
          [
            {
              id: 3644,
              account_number: '0690000034',
              bank_code: '044',
              full_name: 'ADE BOND',
              bank_name: 'ACCESS BANK NIGERIA',
            },
          ],
          { page_info: { current_page: 2, total_pages: 2 } },
        ),
      );

      await expect(addAda(provider)).resolves.toEqual({
        recipientReference: '3644',
        accountName: 'ADE BOND',
        bankName: 'ACCESS BANK NIGERIA',
      });
      expect(calls.slice(2).map((c) => c.url)).toEqual([
        'https://api.flutterwave.test/v3/beneficiaries?page=1',
        'https://api.flutterwave.test/v3/beneficiaries?page=2',
      ]);
    });

    it('reports the original error when the existing beneficiary cannot be found', async () => {
      const { provider } = providerWith(
        resolvedAda,
        alreadyAdded,
        ok([], { page_info: { current_page: 1, total_pages: 1 } }),
      );
      await expect(addAda(provider)).rejects.toThrow(
        'Beneficiary already added',
      );
    });

    it('does not look for an existing beneficiary on other errors', async () => {
      const { provider, calls } = providerWith(resolvedAda, [
        400,
        { status: 'error', message: 'Invalid account', data: null },
      ]);
      await expect(addAda(provider)).rejects.toThrow('Invalid account');
      expect(calls).toHaveLength(2);
    });

    it('refuses payout currencies other than NGN without calling Flutterwave', async () => {
      const { provider, calls } = providerWith();
      await expect(
        provider.payouts.createRecipient({
          currency: 'GHS',
          bankCode: 'GH1',
          accountNumber: '123',
        }),
      ).rejects.toThrow(PaymentProviderError);
      expect(calls).toHaveLength(0);
    });

    it('sends the transfer to the beneficiary in major units, with our reference', async () => {
      const { provider, calls } = providerWith(
        ok({
          id: 408827,
          reference: 'pyt_1',
          status: 'NEW',
          amount: 1000,
          currency: 'NGN',
        }),
      );

      await expect(
        provider.payouts.initiate({
          reference: 'pyt_1',
          amount: 100_000n,
          currency: 'NGN',
          recipientReference: '3644',
          narration: 'Payout',
        }),
      ).resolves.toEqual({ providerReference: '408827', status: 'pending' });
      expect(calls[0]?.body).toEqual({
        beneficiary: 3644,
        amount: 1000,
        currency: 'NGN',
        debit_currency: 'NGN',
        reference: 'pyt_1',
        narration: 'Payout',
      });
    });

    it('finds a transfer by our reference, matching it exactly', async () => {
      const { provider, calls } = providerWith(
        ok([
          { id: 1, reference: 'pyt_other', status: 'SUCCESSFUL' },
          {
            id: 2,
            reference: 'pyt_1',
            status: 'FAILED',
            complete_message: 'Account blocked',
          },
        ]),
      );
      await expect(provider.payouts.find('pyt_1')).resolves.toEqual({
        providerReference: '2',
        status: 'failed',
        failureReason: 'Account blocked',
      });
      expect(calls[0]?.url).toBe(
        'https://api.flutterwave.test/v3/transfers?reference=pyt_1',
      );
    });

    it('returns null when Flutterwave never received the transfer', async () => {
      const { provider } = providerWith(
        ok([{ id: 1, reference: 'pyt_other', status: 'SUCCESSFUL' }]),
      );
      await expect(provider.payouts.find('pyt_1')).resolves.toBeNull();
    });
  });

  describe('reconciliation', () => {
    const range = {
      from: new Date('2026-09-24T00:00:00Z'),
      to: new Date('2026-09-25T00:00:00Z'),
    };

    it('pages through transactions, keeps the range half-open and converts amounts', async () => {
      const { provider, calls } = providerWith(
        ok(
          [
            transaction({
              tx_ref: 'trx_1',
              created_at: '2026-09-24T01:00:00Z',
            }),
            transaction({
              tx_ref: 'trx_2',
              status: 'failed',
              amount: 12.5,
              currency: 'USD',
              created_at: '2026-09-24T02:00:00Z',
            }),
          ],
          { page_info: { total: 4, current_page: 1, total_pages: 2 } },
        ),
        ok(
          [
            // A currency FinStack doesn't support can't be ours: skipped.
            transaction({
              tx_ref: 'other',
              currency: 'XOF',
              created_at: '2026-09-24T03:00:00Z',
            }),
            // Outside the range (Flutterwave filters by whole days).
            transaction({
              tx_ref: 'trx_4',
              created_at: '2026-09-25T00:00:00Z',
            }),
          ],
          { page_info: { total: 4, current_page: 2, total_pages: 2 } },
        ),
      );

      const records = await provider.reconciliation.listPayments(range);

      expect(
        records.map((r) => [r.reference, r.status, r.amount, r.currency]),
      ).toEqual([
        ['trx_1', 'successful', 1_550_000n, 'NGN'],
        ['trx_2', 'failed', 1_250n, 'USD'],
      ]);
      expect(calls[0]?.url).toBe(
        'https://api.flutterwave.test/v3/transactions?from=2026-09-23&to=2026-09-26&page=1',
      );
      expect(calls[1]?.url).toContain('page=2');
    });

    it('lists transfers for payout reconciliation', async () => {
      const { provider } = providerWith(
        ok([
          {
            id: 408827,
            reference: 'pyt_1',
            status: 'SUCCESSFUL',
            amount: 1000,
            currency: 'NGN',
            created_at: '2026-09-24T10:15:08.000Z',
          },
        ]),
      );
      const records = await provider.reconciliation.listPayouts?.(range);
      expect(records).toEqual([
        {
          reference: 'pyt_1',
          providerReference: '408827',
          status: 'successful',
          amount: 100_000n,
          currency: 'NGN',
          createdAt: new Date('2026-09-24T10:15:08.000Z'),
        },
      ]);
    });
  });

  describe('errors', () => {
    it('treats an error envelope as a rejection', async () => {
      const { provider } = providerWith([
        200,
        { status: 'error', message: 'Invalid tx_ref', data: null },
      ]);
      const error = await provider
        .initializePayment({
          reference: 'trx_1',
          amount: 100n,
          currency: 'NGN',
          customerEmail: 'ada@example.com',
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect(error).toMatchObject({
        retryable: false,
        message: 'Flutterwave: Invalid tx_ref',
      });
    });

    it('treats 5xx as retryable and 4xx as a rejection', async () => {
      const outage = providerWith([503, { status: 'error', message: 'Down' }]);
      await expect(outage.provider.getRefund('1')).rejects.toMatchObject({
        retryable: true,
      });

      const rejected = providerWith([
        400,
        { status: 'error', message: 'No transaction was found for this id' },
      ]);
      await expect(rejected.provider.getRefund('1')).rejects.toMatchObject({
        retryable: false,
        httpStatus: 400,
      });
    });
  });
});
