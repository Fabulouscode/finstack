import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Organization } from '../organizations/organization.entity';

/**
 * An organization's HTTPS endpoint that receives signed event callbacks.
 * The signing secret is stored encrypted (SecretBox), since it must be read
 * back to sign; during a rotation the previous one stays valid until
 * `previousSecretExpiresAt`.
 */
@Entity({ name: 'webhook_endpoints' })
@Check('chk_webhook_endpoints_event_types', `cardinality("event_types") > 0`)
@Index('idx_webhook_endpoints_org', ['organizationId'], {
  where: '"deleted_at" IS NULL',
})
export class WebhookEndpoint {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_webhook_endpoints',
  })
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_webhook_endpoints_organization',
  })
  organization?: Organization;

  @Column({ type: 'varchar', length: 2048 })
  url: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  description: string | null;

  /** Subscribed event types, or `*` for all. */
  @Column({ type: 'varchar', length: 50, array: true })
  eventTypes: string[];

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /** Why the system disabled it (e.g. repeated failures); null when enabled by a person. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  disabledReason: string | null;

  /** Sealed signing secret (`whsec_...`). */
  @Column({ type: 'varchar', length: 500 })
  secretSealed: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  previousSecretSealed: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  previousSecretExpiresAt: Date | null;

  /** Deliveries that ran out of attempts in a row; reset by a success. */
  @Column({ type: 'integer', default: 0 })
  consecutiveFailures: number;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', precision: 3 })
  updatedAt: Date;

  /** Deleted endpoints are kept for their delivery history. */
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  deletedAt: Date | null;
}
