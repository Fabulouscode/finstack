import { PaymentsConfig } from '../payments.config';

/** A complete PaymentsConfig for unit tests; override only what a test needs. */
export function paymentsConfigFixture(
  overrides: Partial<PaymentsConfig> = {},
): PaymentsConfig {
  return {
    enabledProviders: ['mock'],
    defaultProvider: 'mock',
    mock: { webhookSecret: 'unit-test-webhook-secret' },
    paystack: {
      secretKey: '',
      baseUrl: 'https://api.paystack.test',
      timeoutMs: 5_000,
    },
    stripe: {
      secretKey: '',
      webhookSecret: '',
      baseUrl: 'https://api.stripe.test',
      timeoutMs: 5_000,
      webhookToleranceSeconds: 300,
      successUrl: 'https://app.example.com/paid',
      cancelUrl: 'https://app.example.com/cancelled',
    },
    ...overrides,
  };
}
