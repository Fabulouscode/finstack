import { paymentsConfigFixture } from '../config/testing/payments-config.fixture';
import { ConfigValidationError } from '../config/validate-config';
import { FlutterwaveProvider } from './flutterwave/flutterwave.provider';
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
    new FlutterwaveProvider(config, http),
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

  it('uses the suggested or requested provider for other currencies', () => {
    expect(routed().select('NGN').name).toBe('paystack');
    expect(routed().select('NGN', 'mock').name).toBe('mock');
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

describe('PaymentProvidersService provider preferences', () => {
  const both = (
    overrides: Parameters<typeof paymentsConfigFixture>[0] = {},
  ): PaymentProvidersService =>
    service({
      enabledProviders: ['paystack', 'stripe'],
      defaultProvider: 'paystack',
      currencyRoutes: {},
      ...overrides,
    });

  it('suggests Paystack for local currencies and Stripe for international ones', () => {
    for (const currency of ['NGN', 'GHS', 'KES', 'ZAR']) {
      expect(both().select(currency).name).toBe('paystack');
    }
    for (const currency of ['USD', 'EUR', 'GBP', 'JPY']) {
      expect(both().select(currency).name).toBe('stripe');
    }
  });

  it('honours the provider the client asks for', () => {
    expect(both().select('USD', 'paystack').name).toBe('paystack');
    expect(both().select('NGN', 'stripe').name).toBe('stripe');
  });

  it("lets the operator's routes win, even over the client", () => {
    const routed = both({ currencyRoutes: { USD: 'paystack' } });
    expect(routed.select('USD').name).toBe('paystack');
    expect(() => routed.select('USD', 'stripe')).toThrow(
      ProviderNotAllowedForCurrencyException,
    );
  });

  it('falls back to the default when the suggested provider is off', () => {
    const stripeOnly = service({
      enabledProviders: ['stripe'],
      defaultProvider: 'stripe',
      currencyRoutes: {},
    });
    expect(stripeOnly.select('NGN').name).toBe('stripe');

    const paystackOnly = service({
      enabledProviders: ['paystack'],
      defaultProvider: 'paystack',
      currencyRoutes: {},
    });
    expect(paystackOnly.select('USD').name).toBe('paystack');
    expect(() => paystackOnly.select('EUR')).toThrow(
      CurrencyNotSupportedByProviderException,
    );
  });

  it('uses Flutterwave when a business chooses it: by route, request or default', () => {
    const all = both({
      enabledProviders: ['paystack', 'stripe', 'flutterwave'],
    });
    // Never suggested over the built-in preferences...
    expect(all.select('NGN').name).toBe('paystack');
    // ...but used whenever the client or the operator picks it.
    expect(all.select('NGN', 'flutterwave').name).toBe('flutterwave');
    expect(
      both({
        enabledProviders: ['paystack', 'stripe', 'flutterwave'],
        currencyRoutes: { KES: 'flutterwave' },
      }).select('KES').name,
    ).toBe('flutterwave');

    const flutterwaveOnly = service({
      enabledProviders: ['flutterwave'],
      defaultProvider: 'flutterwave',
      currencyRoutes: {},
    });
    expect(flutterwaveOnly.select('NGN').name).toBe('flutterwave');
    expect(flutterwaveOnly.select('GBP').name).toBe('flutterwave');
    expect(flutterwaveOnly.selectForPayout('NGN').name).toBe('flutterwave');
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
