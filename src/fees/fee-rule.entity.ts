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

export enum FeeOperation {
  /** Taken from the credit of an incoming payment (the merchant pays). */
  Payment = 'payment',
  /** Added on top of a payout (the sender pays). */
  Payout = 'payout',
  /** Added on top of a transfer (the sender pays). */
  Transfer = 'transfer',
}

/**
 * How much an operation costs in a currency: the platform default, or an
 * organization's negotiated rate. Never edited: a new rule supersedes the
 * active one for its scope, and charged fees keep the rule id they used.
 */
@Entity({ name: 'fee_rules' })
@Check(
  'chk_fee_rules_operation',
  `"operation" IN (${sqlList(Object.values(FeeOperation))})`,
)
@Check('chk_fee_rules_currency', `"currency" ~ '^[A-Z]{3}$'`)
@Check(
  'chk_fee_rules_amounts',
  `"fixed_amount" >= 0 AND "min_amount" >= 0 AND ("max_amount" IS NULL OR "max_amount" >= "min_amount")`,
)
@Check('chk_fee_rules_percentage', `"percentage_bps" BETWEEN 0 AND 10000`)
// One active rule per scope.
@Index('uq_fee_rules_active_default', ['operation', 'currency'], {
  unique: true,
  where: '"organization_id" IS NULL AND "superseded_at" IS NULL',
})
@Index('uq_fee_rules_active_org', ['operation', 'currency', 'organizationId'], {
  unique: true,
  where: '"organization_id" IS NOT NULL AND "superseded_at" IS NULL',
})
export class FeeRule {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_fee_rules' })
  id: string;

  @Column({ type: 'varchar', length: 20 })
  operation: FeeOperation;

  @Column({ type: 'char', length: 3 })
  currency: string;

  /** Null: the platform default for the operation and currency. */
  @Column({ type: 'uuid', nullable: true })
  organizationId: string | null;

  @ManyToOne(() => Organization, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_fee_rules_organization',
  })
  organization?: Organization;

  @Column({ type: 'bigint', transformer: bigintTransformer, default: 0 })
  fixedAmount: bigint;

  @Column({ type: 'integer', default: 0 })
  percentageBps: number;

  @Column({ type: 'bigint', transformer: bigintTransformer, default: 0 })
  minAmount: bigint;

  @Column({
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
  })
  maxAmount: bigint | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  /** When a newer rule (or a retirement) replaced it; null while active. */
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  supersededAt: Date | null;
}
