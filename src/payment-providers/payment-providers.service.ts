import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';
import { paymentsConfig } from '../config/payments.config';
import { ConfigValidationError } from '../config/validate-config';
import type { PaymentsConfig } from '../config/payments.config';
import { FlutterwaveProvider } from './flutterwave/flutterwave.provider';
import { MockPaymentProvider } from './mock/mock-payment.provider';
import { PaymentProvider, PayoutCapability } from './payment-provider';
import { PaystackProvider } from './paystack/paystack.provider';
import { PROVIDER_PREFERENCES } from './provider-preferences';
import { StripeProvider } from './stripe/stripe.provider';

export class ProviderNotAllowedForCurrencyException extends AppException {
  constructor(currency: string, required: string) {
    super(
      'PROVIDER_NOT_ALLOWED_FOR_CURRENCY',
      `${currency} payments must use ${required}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class CurrencyNotSupportedByProviderException extends AppException {
  constructor(provider: string, currency: string) {
    super(
      'CURRENCY_NOT_SUPPORTED_BY_PROVIDER',
      `${provider} cannot charge in ${currency}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class UnknownPaymentProviderException extends AppException {
  constructor(name: string) {
    super(
      'UNKNOWN_PAYMENT_PROVIDER',
      `Payment provider "${name}" is not enabled`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class PayoutsNotSupportedException extends AppException {
  constructor(detail: string) {
    super('PAYOUTS_NOT_SUPPORTED', detail, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

/** A provider together with its payout capability. */
export interface PayoutProvider {
  name: string;
  payouts: PayoutCapability;
}

/** Looks up enabled provider adapters by name. */
@Injectable()
export class PaymentProvidersService {
  private readonly providers: Map<string, PaymentProvider>;
  /** Suggested providers that apply here (enabled and able to charge). */
  private readonly preferred = new Map<string, string>();

  constructor(
    @Inject(paymentsConfig.KEY)
    private readonly config: PaymentsConfig,
    mock: MockPaymentProvider,
    paystack: PaystackProvider,
    stripe: StripeProvider,
    flutterwave: FlutterwaveProvider,
  ) {
    const available: PaymentProvider[] = [mock, paystack, stripe, flutterwave];
    this.providers = new Map(
      available
        .filter((provider) =>
          (config.enabledProviders as string[]).includes(provider.name),
        )
        .map((provider) => [provider.name, provider]),
    );

    // A route to a provider that can't charge the currency is a deployment
    // error: refuse to start rather than fail on the first payment.
    const invalid = Object.entries(config.currencyRoutes)
      .filter(
        ([currency, name]) =>
          !this.providers.get(name)?.supportedCurrencies.includes(currency),
      )
      .map(
        ([currency, name]) =>
          `PAYMENT_CURRENCY_ROUTES: ${name} cannot charge in ${currency}`,
      );
    if (invalid.length > 0) {
      throw new ConfigValidationError('payments', invalid);
    }

    for (const [currency, name] of Object.entries(PROVIDER_PREFERENCES)) {
      if (this.providers.get(name)?.supportedCurrencies.includes(currency)) {
        this.preferred.set(currency, name);
      }
    }
  }

  /**
   * Picks the provider for a payment, in order:
   * 1. the operator's route for the currency (PAYMENT_CURRENCY_ROUTES), which
   *    is a rule: a conflicting request is refused;
   * 2. the provider the client asked for;
   * 3. FinStack's suggestion (PROVIDER_PREFERENCES), if that provider is on;
   * 4. the default provider.
   * The chosen provider must be able to charge the currency.
   */
  select(currency: string, requested?: string): PaymentProvider {
    const routed = this.config.currencyRoutes[currency];
    if (routed) {
      if (requested && requested !== routed) {
        throw new ProviderNotAllowedForCurrencyException(currency, routed);
      }
      return this.get(routed);
    }

    const provider = this.get(
      requested ?? this.preferred.get(currency) ?? this.defaultName,
    );
    if (!provider.supportedCurrencies.includes(currency)) {
      throw new CurrencyNotSupportedByProviderException(
        provider.name,
        currency,
      );
    }
    return provider;
  }

  /**
   * Picks the provider that sends payouts in `currency`: the requested one,
   * or else the currency's route, the default, or any enabled provider that
   * can (in that order).
   */
  selectForPayout(currency: string, requested?: string): PayoutProvider {
    if (requested) {
      const payouts = this.get(requested).payouts;
      if (!payouts?.currencies.includes(currency)) {
        throw new PayoutsNotSupportedException(
          `${requested} cannot send payouts in ${currency}`,
        );
      }
      return { name: requested, payouts };
    }

    const candidates = [
      this.config.currencyRoutes[currency],
      this.preferred.get(currency),
      this.defaultName,
      ...this.providers.keys(),
    ];
    for (const name of candidates) {
      const payouts = name ? this.providers.get(name)?.payouts : undefined;
      if (name && payouts?.currencies.includes(currency)) {
        return { name, payouts };
      }
    }
    throw new PayoutsNotSupportedException(
      `No enabled provider can send payouts in ${currency}`,
    );
  }

  /** The payout capability of a provider a payout was already routed to. */
  payoutsOf(name: string): PayoutCapability {
    const payouts = this.get(name).payouts;
    if (!payouts) {
      throw new PayoutsNotSupportedException(`${name} cannot send payouts`);
    }
    return payouts;
  }

  get defaultName(): string {
    return this.config.defaultProvider;
  }

  get(name: string): PaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new UnknownPaymentProviderException(name);
    }
    return provider;
  }

  enabledNames(): string[] {
    return [...this.providers.keys()];
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }
}
