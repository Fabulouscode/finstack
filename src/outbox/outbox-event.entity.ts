import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum OutboxEventStatus {
  Pending = 'pending',
  Published = 'published',
}

/**
 * An event recorded in the same database transaction as the state change it
 * describes, then published to a queue by the relay. This removes the "saved
 * the payment but lost the event" failure mode (and its opposite).
 */
@Entity({ name: 'outbox_events' })
@Check('chk_outbox_events_status', `"status" IN ('pending', 'published')`)
// The relay's work queue: only pending rows, oldest first.
@Index('idx_outbox_events_pending', ['availableAt', 'createdAt'], {
  where: `"status" = 'pending'`,
})
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_outbox_events',
  })
  id: string;

  /** e.g. `payment.successful`, `webhook.received`. */
  @Column({ type: 'varchar', length: 100 })
  type: string;

  /** The entity the event is about, e.g. `transaction`. */
  @Column({ type: 'varchar', length: 50 })
  aggregateType: string;

  @Column({ type: 'uuid' })
  aggregateId: string;

  @Column({ type: 'jsonb' })
  payload: object;

  @Column({ type: 'varchar', length: 20, default: OutboxEventStatus.Pending })
  status: OutboxEventStatus;

  @Column({ type: 'integer', default: 0 })
  publishAttempts: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;

  /** Not published before this time (used to back off after publish errors). */
  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  availableAt: Date;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  publishedAt: Date | null;
}
