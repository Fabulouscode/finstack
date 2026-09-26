import { Injectable } from '@nestjs/common';
import { DomainEventHandler } from '../events/domain-event-handler';
import type { DomainEventMessage } from '../outbox/outbox.service';
import { MetricsService } from './metrics.service';

/** Counts business events: payments, refunds, payouts, transfers... */
@Injectable()
export class MetricsEventHandler implements DomainEventHandler {
  readonly handles = '*' as const;

  constructor(private readonly metrics: MetricsService) {}

  handle(event: DomainEventMessage): Promise<void> {
    this.metrics.countDomainEvent(event.type);
    return Promise.resolve();
  }
}
