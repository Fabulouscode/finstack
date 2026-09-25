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
import { Organization } from '../organizations/organization.entity';
import { User } from '../users/user.entity';

/**
 * A secret for server-to-server calls on behalf of an organization. Only a
 * SHA-256 hash of the key is stored; the key itself is shown once.
 */
@Entity({ name: 'api_keys' })
@Check('chk_api_keys_scopes_not_empty', `cardinality("scopes") > 0`)
@Index('idx_api_keys_organization_id', ['organizationId'])
export class ApiKey {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_api_keys' })
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_api_keys_organization',
  })
  organization?: Organization;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** Non-secret identifier shown in dashboards, e.g. `fsk_test_1a2b3c4d`. */
  @Index('uq_api_keys_prefix', { unique: true })
  @Column({ type: 'varchar', length: 40 })
  prefix: string;

  @Index('uq_api_keys_key_hash', { unique: true })
  @Column({ type: 'char', length: 64 })
  keyHash: string;

  /** Organization permissions this key may use. */
  @Column({ type: 'varchar', length: 50, array: true })
  scopes: string[];

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'created_by_user_id',
    foreignKeyConstraintName: 'fk_api_keys_created_by',
  })
  createdBy?: User;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
