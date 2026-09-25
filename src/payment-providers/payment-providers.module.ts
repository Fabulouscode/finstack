import { Module } from '@nestjs/common';
import { JsonHttpClient } from './http/json-http-client';
import { MockPaymentProvider } from './mock/mock-payment.provider';
import { PaymentProvidersService } from './payment-providers.service';
import { PaystackProvider } from './paystack/paystack.provider';
import { StripeProvider } from './stripe/stripe.provider';

/** Adapters for external payment providers, behind one interface. */
@Module({
  providers: [
    { provide: JsonHttpClient, useFactory: () => new JsonHttpClient() },
    MockPaymentProvider,
    PaystackProvider,
    StripeProvider,
    PaymentProvidersService,
  ],
  exports: [PaymentProvidersService, MockPaymentProvider],
})
export class PaymentProvidersModule {}
