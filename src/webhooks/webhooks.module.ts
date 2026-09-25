import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentProvidersModule } from '../payment-providers/payment-providers.module';
import { PaymentsModule } from '../payments/payments.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { QueuesModule } from '../queues/queues.module';
import { RefundsModule } from '../refunds/refunds.module';
import { AdminWebhooksController } from './admin-webhooks.controller';
import { MockCheckoutController } from './mock-checkout.controller';
import { WebhookEvent } from './webhook-event.entity';
import { WebhooksController } from './webhooks.controller';
import { WebhooksProcessor } from './webhooks.processor';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([WebhookEvent]),
    PaymentProvidersModule,
    PaymentsModule,
    OutboxModule,
    QueuesModule,
    RefundsModule,
    PayoutsModule,
  ],
  controllers: [
    WebhooksController,
    MockCheckoutController,
    AdminWebhooksController,
  ],
  providers: [WebhooksService, WebhooksProcessor],
  exports: [WebhooksService],
})
export class WebhooksModule {}
