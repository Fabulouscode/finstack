import { paymentsConfigFixture } from '../config/testing/payments-config.fixture';
import { ConfigValidationError } from '../config/validate-config';
import { JsonHttpClient } from './http/json-http-client';
import { MockPaymentProvider } from './mock/mock-payment.provider';
import {
  CurrencyNotSupportedByProviderException,
  PaymentProvidersService,
  PayoutsNotSupportedException,
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

describe('PaymentProvidersService.selectForPayout', () => {
  it('prefers the currency route, then the default, then any capable provider', () => {
    const providers = service({
      enabledProviders: ['stripe', 'paystack'],
      defaultProvider: 'stripe',
      currencyRoutes: {},
    });
    // Stripe can't pay out (Connect is out of scope), so Paystack is used.
    expect(providers.selectForPayout('NGN').name).toBe('paystack');
  });

  it('rejects a requested provider that cannot pay out in the currency', () => {
    const providers = service({
      enabledProviders: ['stripe', 'paystack'],
      defaultProvider: 'paystack',
      currencyRoutes: {},
    });
    expect(() => providers.selectForPayout('NGN', 'stripe')).toThrow(
      PayoutsNotSupportedException,
    );
    expect(() => providers.selectForPayout('USD', 'paystack')).toThrow(
      PayoutsNotSupportedException,
    );
  });

  it('fails when no enabled provider can pay out in the currency', () => {
    const providers = service({
      enabledProviders: ['stripe'],
      defaultProvider: 'stripe',
      currencyRoutes: {},
    });
    expect(() => providers.selectForPayout('USD')).toThrow(
      PayoutsNotSupportedException,
    );
  });
});
