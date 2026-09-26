import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { sqlList } from '../ledger/ledger.types';
import { WebhookEndpoint } from './webhook-endpoint.entity';

export enum WebhookDeliveryStatus {
  Pending = 'pending',
  Succeeded = 'succeeded',
  Failed = 'failed',
}

/** One event sent (and retried) to one endpoint. */
@Entity({ name: 'webhook_deliveries' })
@Check(
  'chk_webhook_deliveries_status',
  `"status" IN (${sqlList(Object.values(WebhookDeliveryStatus))})`,
)
// Fan-out is at-least-once; this makes it exactly one delivery per event.
@Index('uq_webhook_deliveries_endpoint_event', ['endpointId', 'eventId'], {
  unique: true,
})
@Index('idx_webhook_deliveries_endpoint_created_id', [
  'endpointId',
  'createdAt',
  'id',
])
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_webhook_deliveries',
  })
  id: string;

  @Column({ type: 'uuid' })
  endpointId: string;

  @ManyToOne(() => WebhookEndpoint, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'endpoint_id',
    foreignKeyConstraintName: 'fk_webhook_deliveries_endpoint',
  })
  endpoint?: WebhookEndpoint;

  /** The event's id (the outbox event id, or a test ping's); receivers dedupe on it. */
  @Column({ type: 'uuid' })
  eventId: string;

  @Column({ type: 'varchar', length: 100 })
  eventType: string;

  /** Exactly what is sent (and re-sent) as the request body. */
  @Column({ type: 'jsonb' })
  payload: object;

  @Column({ type: 'varchar', length: 20 })
  status: WebhookDeliveryStatus;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ type: 'integer', nullable: true })
  lastResponseStatus: number | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  lastAttemptAt: Date | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  deliveredAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
