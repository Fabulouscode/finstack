import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';
import { paymentsConfig } from '../config/payments.config';
import type { PaymentsConfig } from '../config/payments.config';
import { MockPaymentProvider } from './mock/mock-payment.provider';
import { PaymentProvider } from './payment-provider';
import { PaystackProvider } from './paystack/paystack.provider';
import { StripeProvider } from './stripe/stripe.provider';

export class UnknownPaymentProviderException extends AppException {
  constructor(name: string) {
    super(
      'UNKNOWN_PAYMENT_PROVIDER',
      `Payment provider "${name}" is not enabled`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/** Looks up enabled provider adapters by name. */
@Injectable()
export class PaymentProvidersService {
  private readonly providers: Map<string, PaymentProvider>;

  constructor(
    @Inject(paymentsConfig.KEY)
    private readonly config: PaymentsConfig,
    mock: MockPaymentProvider,
    paystack: PaystackProvider,
    stripe: StripeProvider,
  ) {
    const available: PaymentProvider[] = [mock, paystack, stripe];
    this.providers = new Map(
      available
        .filter((provider) =>
          (config.enabledProviders as string[]).includes(provider.name),
        )
        .map((provider) => [provider.name, provider]),
    );
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

  has(name: string): boolean {
    return this.providers.has(name);
  }
}
