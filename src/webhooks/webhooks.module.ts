import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentProvidersModule } from '../payment-providers/payment-providers.module';
import { PaymentsModule } from '../payments/payments.module';
import { MockCheckoutController } from './mock-checkout.controller';
import { WebhookEvent } from './webhook-event.entity';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([WebhookEvent]),
    PaymentProvidersModule,
    PaymentsModule,
  ],
  controllers: [WebhooksController, MockCheckoutController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
