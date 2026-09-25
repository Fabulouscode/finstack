import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { sqlList } from '../ledger/ledger.types';

export enum AuditActorType {
  User = 'user',
  ApiKey = 'api_key',
  System = 'system',
}

/**
 * Append-only record of who did what (sensitive and administrative actions).
 * A database trigger rejects UPDATE and DELETE.
 *
 * Ids are stored without foreign keys on purpose: the trail is history and
 * must not depend on (or block changes to) the rows it mentions.
 */
@Entity({ name: 'audit_logs' })
@Check(
  'chk_audit_logs_actor_type',
  `"actor_type" IN (${sqlList(Object.values(AuditActorType))})`,
)
@Check(
  'chk_audit_logs_actor_id',
  `("actor_type" = 'system') = ("actor_id" IS NULL)`,
)
@Index('idx_audit_logs_created_id', ['createdAt', 'id'])
@Index('idx_audit_logs_org_created_id', ['organizationId', 'createdAt', 'id'])
@Index('idx_audit_logs_actor_created', ['actorId', 'createdAt'])
@Index('idx_audit_logs_target', ['targetType', 'targetId'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_audit_logs' })
  id: string;

  @Column({ type: 'varchar', length: 20 })
  actorType: AuditActorType;

  /** User or API key id; null for the system. */
  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

  /** Set when the action happened within (or to) an organization. */
  @Column({ type: 'uuid', nullable: true })
  organizationId: string | null;

  /** Dotted verb, e.g. `member.role_changed`. */
  @Column({ type: 'varchar', length: 100 })
  action: string;

  @Column({ type: 'varchar', length: 50 })
  targetType: string;

  @Column({ type: 'varchar', length: 100 })
  targetId: string;

  /** Details such as before/after values. Never secrets. */
  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, unknown>;

  @Column({ type: 'varchar', length: 128, nullable: true })
  requestId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ipAddress: string | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
