import { Injectable } from '@nestjs/common';
import { DomainEventHandler } from '../events/domain-event-handler';
import type { DomainEventMessage } from '../outbox/outbox.service';
import { OutboundWebhooksService } from './outbound-webhooks.service';

/** Turns domain events into deliveries for subscribed endpoints. */
@Injectable()
export class OutboundWebhooksEventHandler implements DomainEventHandler {
  readonly handles = '*' as const;

  constructor(private readonly webhooks: OutboundWebhooksService) {}

  async handle(event: DomainEventMessage): Promise<void> {
    await this.webhooks.fanOut(event);
  }
}
