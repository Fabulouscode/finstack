import { paymentsConfig } from './payments.config';
import { ConfigValidationError } from './validate-config';

describe('paymentsConfig', () => {
  const originalEnv = process.env;
  const secret = 'a-long-enough-secret';

  beforeEach(() => {
    process.env = { MOCK_PROVIDER_WEBHOOK_SECRET: secret };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('enables the mock provider by default outside production', () => {
    expect(paymentsConfig()).toEqual({
      enabledProviders: ['mock'],
      defaultProvider: 'mock',
      mock: { webhookSecret: secret },
      paystack: {
        secretKey: '',
        baseUrl: 'https://api.paystack.co',
        timeoutMs: 10_000,
      },
    });
  });

  it('refuses the mock provider in production', () => {
    process.env.NODE_ENV = 'production';

    expect(() => paymentsConfig()).toThrow(/must not be enabled in production/);
  });

  it('requires a webhook secret for the mock provider', () => {
    delete process.env.MOCK_PROVIDER_WEBHOOK_SECRET;

    expect(() => paymentsConfig()).toThrow(
      /MOCK_PROVIDER_WEBHOOK_SECRET is required/,
    );
  });

  describe('Paystack', () => {
    it('requires a secret key when enabled', () => {
      process.env.PAYMENT_PROVIDERS = 'paystack';

      expect(() => paymentsConfig()).toThrow(/PAYSTACK_SECRET_KEY is required/);
    });

    it('accepts a test key outside production', () => {
      process.env.PAYMENT_PROVIDERS = 'paystack,mock';
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc123';

      expect(paymentsConfig()).toMatchObject({
        enabledProviders: ['paystack', 'mock'],
        defaultProvider: 'paystack',
        paystack: { secretKey: 'sk_test_abc123' },
      });
    });

    it('refuses a live key outside production, and a test key in production', () => {
      process.env.PAYMENT_PROVIDERS = 'paystack';
      process.env.PAYSTACK_SECRET_KEY = 'sk_live_abc123';
      expect(() => paymentsConfig()).toThrow(
        /live key may only be used in production/,
      );

      process.env.NODE_ENV = 'production';
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc123';
      expect(() => paymentsConfig()).toThrow(
        /test key must not be used in production/,
      );
    });

    it('rejects a malformed key', () => {
      process.env.PAYSTACK_SECRET_KEY = 'pk_test_public';

      expect(() => paymentsConfig()).toThrow(ConfigValidationError);
    });
  });

  it.each([
    ['PAYMENT_PROVIDERS', 'paypal'],
    ['PAYMENT_PROVIDERS', ''],
    ['DEFAULT_PAYMENT_PROVIDER', 'paystack'],
    ['MOCK_PROVIDER_WEBHOOK_SECRET', 'short'],
  ])('rejects %s=%p', (name, value) => {
    process.env[name] = value;

    expect(() => paymentsConfig()).toThrow(ConfigValidationError);
  });
});
