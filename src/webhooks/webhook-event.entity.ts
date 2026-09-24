import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum WebhookEventStatus {
  Received = 'received',
  Processed = 'processed',
  /** Processing threw (e.g. provider outage); eligible for retry/replay. */
  Failed = 'failed',
  /** Valid but irrelevant (unknown type or payment); kept for audit. */
  Ignored = 'ignored',
}

/**
 * Every verified webhook, stored before processing. The unique
 * (provider, event_id) index is the duplicate-delivery guard.
 */
@Entity({ name: 'webhook_events' })
@Index('uq_webhook_events_provider_event', ['provider', 'eventId'], {
  unique: true,
})
@Index('idx_webhook_events_status_received', ['status', 'receivedAt'])
@Check(
  'chk_webhook_events_status',
  `"status" IN ('received', 'processed', 'failed', 'ignored')`,
)
export class WebhookEvent {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_webhook_events',
  })
  id: string;

  @Column({ type: 'varchar', length: 50 })
  provider: string;

  @Column({ type: 'varchar', length: 255 })
  eventId: string;

  /** Normalised type, e.g. `payment.succeeded`. */
  @Column({ type: 'varchar', length: 100 })
  type: string;

  /** The provider's own type string. */
  @Column({ type: 'varchar', length: 100 })
  providerType: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  providerReference: string | null;

  /** The verified raw payload, for audit and replay. */
  @Column({ type: 'jsonb' })
  payload: object;

  @Column({ type: 'varchar', length: 20 })
  status: WebhookEventStatus;

  /** Result of the last processing attempt, e.g. `credited`. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  outcome: string | null;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  receivedAt: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  processedAt: Date | null;
}
