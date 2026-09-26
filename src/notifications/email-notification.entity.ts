import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { sqlList } from '../ledger/ledger.types';

export enum EmailNotificationStatus {
  Pending = 'pending',
  Sent = 'sent',
  Failed = 'failed',
}

/**
 * One email per event, template and recipient. Domain events arrive at
 * least once; this row makes sure each email is sent once.
 */
@Entity({ name: 'email_notifications' })
@Check(
  'chk_email_notifications_status',
  `"status" IN (${sqlList(Object.values(EmailNotificationStatus))})`,
)
@Index(
  'uq_email_notifications_event_template_recipient',
  ['eventId', 'template', 'recipientUserId'],
  { unique: true },
)
@Index('idx_email_notifications_recipient_created', [
  'recipientUserId',
  'createdAt',
])
export class EmailNotification {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_email_notifications',
  })
  id: string;

  @Column({ type: 'uuid' })
  eventId: string;

  @Column({ type: 'varchar', length: 50 })
  template: string;

  @Column({ type: 'uuid' })
  recipientUserId: string;

  @Column({ type: 'varchar', length: 320 })
  toEmail: string;

  @Column({ type: 'varchar', length: 200 })
  subject: string;

  @Column({ type: 'varchar', length: 20 })
  status: EmailNotificationStatus;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  sentAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
