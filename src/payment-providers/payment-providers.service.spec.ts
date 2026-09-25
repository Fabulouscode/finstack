import { paymentsConfigFixture } from '../config/testing/payments-config.fixture';
import { ConfigValidationError } from '../config/validate-config';
import { JsonHttpClient } from './http/json-http-client';
import { MockPaymentProvider } from './mock/mock-payment.provider';
import {
  CurrencyNotSupportedByProviderException,
  PaymentProvidersService,
  ProviderNotAllowedForCurrencyException,
  UnknownPaymentProviderException,
} from './payment-providers.service';
import { PaystackProvider } from './paystack/paystack.provider';
import { StripeProvider } from './stripe/stripe.provider';

function service(
  overrides: Parameters<typeof paymentsConfigFixture>[0],
): PaymentProvidersService {
  const config = paymentsConfigFixture(overrides);
  const http = new JsonHttpClient();
  return new PaymentProvidersService(
    config,
    new MockPaymentProvider(config),
    new PaystackProvider(config, http),
    new StripeProvider(config, http),
  );
}

describe('PaymentProvidersService.select', () => {
  const routed = (): PaymentProvidersService =>
    service({
      enabledProviders: ['mock', 'paystack', 'stripe'],
      defaultProvider: 'mock',
      currencyRoutes: { USD: 'stripe' },
    });

  it('always uses the routed provider for a routed currency', () => {
    expect(routed().select('USD').name).toBe('stripe');
    expect(routed().select('USD', 'stripe').name).toBe('stripe');
  });

  it('rejects an explicit provider that conflicts with the route', () => {
    expect(() => routed().select('USD', 'mock')).toThrow(
      ProviderNotAllowedForCurrencyException,
    );
  });

  it('uses the requested or default provider for other currencies', () => {
    expect(routed().select('NGN').name).toBe('mock');
    expect(routed().select('NGN', 'paystack').name).toBe('paystack');
  });

  it('rejects currencies the chosen provider cannot charge', () => {
    expect(() => routed().select('JPY', 'paystack')).toThrow(
      CurrencyNotSupportedByProviderException,
    );
  });

  it('rejects providers that are not enabled', () => {
    expect(() => service({}).select('USD', 'stripe')).toThrow(
      UnknownPaymentProviderException,
    );
  });

  it('refuses to start with a route the provider cannot serve', () => {
    expect(() =>
      service({
        enabledProviders: ['paystack'],
        defaultProvider: 'paystack',
        currencyRoutes: { JPY: 'paystack' },
      }),
    ).toThrow(ConfigValidationError);
  });
});
