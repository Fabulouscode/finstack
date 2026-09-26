import { Injectable } from '@nestjs/common';
import { DomainEventHandler } from '../events/domain-event-handler';
import type { DomainEventMessage } from '../outbox/outbox.service';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationsEventHandler implements DomainEventHandler {
  readonly handles = [
    'payment.successful',
    'refund.successful',
    'payout.successful',
    'payout.failed',
    'payout.reversed',
    'transfer.completed',
  ] as const;

  constructor(private readonly notifications: NotificationsService) {}

  async handle(event: DomainEventMessage): Promise<void> {
    await this.notifications.handle(event);
  }
}
