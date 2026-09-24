import { Module } from '@nestjs/common';
import { MockPaymentProvider } from './mock/mock-payment.provider';
import { PaymentProvidersService } from './payment-providers.service';

/** Adapters for external payment providers, behind one interface. */
@Module({
  providers: [MockPaymentProvider, PaymentProvidersService],
  exports: [PaymentProvidersService, MockPaymentProvider],
})
export class PaymentProvidersModule {}
