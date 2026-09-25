import { DomainEventMessage } from '../outbox/outbox.service';

/**
 * Reacts to a domain event (e.g. send a receipt on payment.successful).
 * Delivery is at-least-once: handlers must be idempotent, keyed on
 * `event.eventId`.
 */
export interface DomainEventHandler {
  /** Event types handled, or '*' for all. */
  readonly handles: readonly string[] | '*';
  handle(event: DomainEventMessage): Promise<void>;
}

export const DOMAIN_EVENT_HANDLERS = Symbol('DOMAIN_EVENT_HANDLERS');
