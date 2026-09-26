import { Module } from '@nestjs/common';
import { OutboundWebhooksEventHandler } from '../outbound-webhooks/outbound-webhooks.event-handler';
import { OutboundWebhooksModule } from '../outbound-webhooks/outbound-webhooks.module';
import { QueuesModule } from '../queues/queues.module';
import { DOMAIN_EVENT_HANDLERS } from './domain-event-handler';
import { DomainEventsProcessor } from './domain-events.processor';
import { LoggingEventHandler } from './logging-event.handler';

/**
 * Domain event consumers. Register new handlers (notifications, analytics,
 * outgoing merchant webhooks) in the DOMAIN_EVENT_HANDLERS factory.
 */
@Module({
  imports: [QueuesModule, OutboundWebhooksModule],
  providers: [
    LoggingEventHandler,
    {
      provide: DOMAIN_EVENT_HANDLERS,
      inject: [LoggingEventHandler, OutboundWebhooksEventHandler],
      useFactory: (...handlers: unknown[]) => handlers,
    },
    DomainEventsProcessor,
  ],
})
export class EventsModule {}
