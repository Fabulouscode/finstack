import { Module } from '@nestjs/common';
import { QueuesModule } from '../queues/queues.module';
import { DOMAIN_EVENT_HANDLERS } from './domain-event-handler';
import { DomainEventsProcessor } from './domain-events.processor';
import { LoggingEventHandler } from './logging-event.handler';

/**
 * Domain event consumers. Register new handlers (notifications, analytics,
 * outgoing merchant webhooks) in the DOMAIN_EVENT_HANDLERS factory.
 */
@Module({
  imports: [QueuesModule],
  providers: [
    LoggingEventHandler,
    {
      provide: DOMAIN_EVENT_HANDLERS,
      inject: [LoggingEventHandler],
      useFactory: (...handlers: unknown[]) => handlers,
    },
    DomainEventsProcessor,
  ],
})
export class EventsModule {}
