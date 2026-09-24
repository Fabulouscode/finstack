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

  it.each([
    ['PAYMENT_PROVIDERS', 'paypal'],
    ['PAYMENT_PROVIDERS', ''],
    ['DEFAULT_PAYMENT_PROVIDER', 'stripe'],
    ['MOCK_PROVIDER_WEBHOOK_SECRET', 'short'],
  ])('rejects %s=%p', (name, value) => {
    process.env[name] = value;

    expect(() => paymentsConfig()).toThrow(ConfigValidationError);
  });
});
