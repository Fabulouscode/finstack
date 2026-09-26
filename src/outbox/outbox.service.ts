import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxEvent, OutboxEventStatus } from './outbox-event.entity';

export interface NewOutboxEvent {
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: object;
}

/** The envelope delivered to queue consumers. */
export interface DomainEventMessage {
  /** The outbox event id: stable across redeliveries, use it to dedupe. */
  eventId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  data: object;
}

@Injectable()
export class OutboxService {
  /** Removes published events older than `days` (maintenance). Returns how many. */
  async deletePublishedWithin(
    manager: EntityManager,
    days: number,
  ): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .delete()
      .from(OutboxEvent)
      .where('status = :status', { status: OutboxEventStatus.Published })
      .andWhere('published_at < now() - make_interval(days => :days)', {
        days,
      })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Records an event inside the caller's database transaction. It becomes
   * visible to the relay only if that transaction commits.
   */
  async add(
    manager: EntityManager,
    event: NewOutboxEvent,
  ): Promise<OutboxEvent> {
    return manager.save(
      manager.create(OutboxEvent, {
        ...event,
        status: OutboxEventStatus.Pending,
        publishAttempts: 0,
        lastError: null,
        publishedAt: null,
      }),
    );
  }
}

export function toMessage(event: OutboxEvent): DomainEventMessage {
  return {
    eventId: event.id,
    type: event.type,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    occurredAt: event.createdAt.toISOString(),
    data: event.payload,
  };
}
