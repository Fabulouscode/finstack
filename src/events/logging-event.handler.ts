import { Injectable, Logger } from '@nestjs/common';
import { DomainEventMessage } from '../outbox/outbox.service';
import { DomainEventHandler } from './domain-event-handler';

/** Default subscriber: a structured log line per domain event. */
@Injectable()
export class LoggingEventHandler implements DomainEventHandler {
  readonly handles = '*' as const;
  private readonly logger = new Logger('DomainEvents');

  handle(event: DomainEventMessage): Promise<void> {
    this.logger.log(
      JSON.stringify({
        eventId: event.eventId,
        type: event.type,
        aggregate: `${event.aggregateType}:${event.aggregateId}`,
        occurredAt: event.occurredAt,
      }),
    );
    return Promise.resolve();
  }
}
