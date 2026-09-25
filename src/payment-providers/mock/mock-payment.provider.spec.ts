import { paymentsConfigFixture } from '../../config/testing/payments-config.fixture';
import {
  InitializePaymentResult,
  PaymentProviderError,
  VerifyPaymentResult,
} from '../payment-provider';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from './mock-payment.provider';

const config = paymentsConfigFixture();

describe('MockPaymentProvider', () => {
  let provider: MockPaymentProvider;

  beforeEach(() => {
    provider = new MockPaymentProvider(config);
  });

  const initialize = (): Promise<InitializePaymentResult> =>
    provider.initializePayment({
      reference: 'trx_1',
      amount: 1_000n,
      currency: 'USD',
      customerEmail: 'ada@example.com',
    });

  it('is idempotent by our reference', async () => {
    const first = await initialize();
    const again = await initialize();

    expect(again.providerReference).toBe(first.providerReference);
    expect(first.authorizationUrl).toContain(first.providerReference);
  });

  it('reports pending until the checkout completes, then the outcome', async () => {
    const { providerReference } = await initialize();
    const verify = (): Promise<VerifyPaymentResult> =>
      provider.verifyPayment({ reference: 'trx_1', providerReference });

    await expect(verify()).resolves.toMatchObject({
      status: 'pending',
      amount: 1_000n,
    });
    provider.simulateOutcome(providerReference, 'successful');
    await expect(verify()).resolves.toMatchObject({
      status: 'successful',
      currency: 'USD',
    });
  });

  it('refuses to verify a payment under another reference', async () => {
    const { providerReference } = await initialize();

    await expect(
      provider.verifyPayment({ reference: 'trx_other', providerReference }),
    ).rejects.toThrow(PaymentProviderError);
  });

  describe('webhook signatures', () => {
    it('accepts the signature it produced over the exact bytes', async () => {
      const { providerReference } = await initialize();
      const { rawBody, signature } = provider.simulateOutcome(
        providerReference,
        'successful',
      );

      expect(
        provider.verifyWebhookSignature(rawBody, {
          [MOCK_SIGNATURE_HEADER]: signature,
        }),
      ).toBe(true);
      expect(provider.parseWebhookEvent(rawBody)).toMatchObject({
        type: 'payment.succeeded',
        providerType: 'charge.success',
        providerReference,
        reference: 'trx_1',
      });
    });

    it('rejects a tampered body, a wrong secret, and malformed or missing signatures', async () => {
      const { providerReference } = await initialize();
      const { rawBody, signature } = provider.simulateOutcome(
        providerReference,
        'successful',
      );
      const tampered = Buffer.from(
        rawBody.toString().replace('"1000"', '"999999"'),
      );
      const otherSecret = new MockPaymentProvider(
        paymentsConfigFixture({
          mock: { webhookSecret: 'a-different-webhook-secret' },
        }),
      ).sign(rawBody);

      expect(
        provider.verifyWebhookSignature(tampered, {
          [MOCK_SIGNATURE_HEADER]: signature,
        }),
      ).toBe(false);
      expect(
        provider.verifyWebhookSignature(rawBody, {
          [MOCK_SIGNATURE_HEADER]: otherSecret,
        }),
      ).toBe(false);
      expect(
        provider.verifyWebhookSignature(rawBody, {
          [MOCK_SIGNATURE_HEADER]: 'abc',
        }),
      ).toBe(false);
      expect(provider.verifyWebhookSignature(rawBody, {})).toBe(false);
    });
  });
});
