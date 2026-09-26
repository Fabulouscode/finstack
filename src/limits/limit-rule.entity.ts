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
import { bigintTransformer } from '../database/transformers';
import { sqlList } from '../ledger/ledger.types';
import { Organization } from '../organizations/organization.entity';

export enum LimitOperation {
  /** Incoming payments (e.g. per verification tier). */
  Payment = 'payment',
  Payout = 'payout',
  Transfer = 'transfer',
}

/**
 * How much an owner may move per operation and currency: the platform
 * default for everyone, or an organization's own limits. Any cap may be
 * left empty (unlimited). Never edited: a new rule supersedes the active
 * one for its scope.
 */
@Entity({ name: 'limit_rules' })
@Check(
  'chk_limit_rules_operation',
  `"operation" IN (${sqlList(Object.values(LimitOperation))})`,
)
@Check('chk_limit_rules_currency', `"currency" ~ '^[A-Z]{3}$'`)
@Check(
  'chk_limit_rules_values',
  `("max_per_transaction" IS NULL OR "max_per_transaction" > 0)
   AND ("max_daily_amount" IS NULL OR "max_daily_amount" > 0)
   AND ("max_daily_count" IS NULL OR "max_daily_count" > 0)
   AND ("max_monthly_amount" IS NULL OR "max_monthly_amount" > 0)`,
)
@Index('uq_limit_rules_active_default', ['operation', 'currency'], {
  unique: true,
  where: '"organization_id" IS NULL AND "superseded_at" IS NULL',
})
@Index(
  'uq_limit_rules_active_org',
  ['operation', 'currency', 'organizationId'],
  {
    unique: true,
    where: '"organization_id" IS NOT NULL AND "superseded_at" IS NULL',
  },
)
export class LimitRule {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_limit_rules',
  })
  id: string;

  @Column({ type: 'varchar', length: 20 })
  operation: LimitOperation;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'uuid', nullable: true })
  organizationId: string | null;

  @ManyToOne(() => Organization, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_limit_rules_organization',
  })
  organization?: Organization;

  /** Minor units; null = no cap. */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  maxPerTransaction: bigint | null;

  /** Rolling 24 hours. */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  maxDailyAmount: bigint | null;

  /** Rolling 24 hours. */
  @Column({ type: 'integer', nullable: true })
  maxDailyCount: number | null;

  /** Rolling 30 days. */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  maxMonthlyAmount: bigint | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  supersededAt: Date | null;
}
