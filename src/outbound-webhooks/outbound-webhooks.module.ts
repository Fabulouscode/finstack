import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SecretBox } from '../common/crypto/secret-box';
import { OrganizationsModule } from '../organizations/organizations.module';
import { QueuesModule } from '../queues/queues.module';
import { OutboundWebhooksEventHandler } from './outbound-webhooks.event-handler';
import { OutboundWebhooksProcessor } from './outbound-webhooks.processor';
import { OutboundWebhooksService } from './outbound-webhooks.service';
import { WebhookDelivery } from './webhook-delivery.entity';
import { WebhookEndpoint } from './webhook-endpoint.entity';
import { WebhookEndpointsController } from './webhook-endpoints.controller';
import { WebhookSender } from './webhook-sender';
import { WebhookUrlPolicy } from './webhook-url-policy';

/** Signed event callbacks to organizations' endpoints ("merchant webhooks"). */
@Module({
  imports: [
    TypeOrmModule.forFeature([WebhookEndpoint, WebhookDelivery]),
    OrganizationsModule,
    QueuesModule,
  ],
  controllers: [WebhookEndpointsController],
  providers: [
    OutboundWebhooksService,
    OutboundWebhooksEventHandler,
    OutboundWebhooksProcessor,
    SecretBox,
    WebhookSender,
    WebhookUrlPolicy,
  ],
  exports: [OutboundWebhooksService, OutboundWebhooksEventHandler],
})
export class OutboundWebhooksModule {}
