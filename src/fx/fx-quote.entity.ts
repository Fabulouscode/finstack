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
import { LedgerTransaction } from '../ledger/ledger-transaction.entity';
import { User } from '../users/user.entity';
import { FxRate } from './fx-rate.entity';

/**
 * A locked conversion offer: "pay X source, receive Y target", valid until
 * `expiresAt`. Consumed at most once, by one conversion reference.
 */
@Entity({ name: 'fx_quotes' })
@Check(
  'chk_fx_quotes_distinct_currencies',
  `"source_currency" <> "target_currency"`,
)
@Check(
  'chk_fx_quotes_amounts_positive',
  `"source_amount" > 0 AND "target_amount" > 0`,
)
@Check('chk_fx_quotes_spread', `"spread_bps" >= 0 AND "spread_bps" < 10000`)
@Check(
  'chk_fx_quotes_target_within_gross',
  `"target_amount" <= "gross_target_amount"`,
)
@Check(
  'chk_fx_quotes_consumption_complete',
  `("consumed_at" IS NULL) = ("conversion_reference" IS NULL)`,
)
@Index('idx_fx_quotes_user_id', ['userId'])
export class FxQuote {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_fx_quotes' })
  id: string;

  /** Owner; null for system-initiated quotes. */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_fx_quotes_user',
  })
  user?: User;

  @Column({ type: 'uuid' })
  fxRateId: string;

  @ManyToOne(() => FxRate, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'fx_rate_id',
    foreignKeyConstraintName: 'fk_fx_quotes_fx_rate',
  })
  fxRate?: FxRate;

  @Column({ type: 'char', length: 3 })
  sourceCurrency: string;

  @Column({ type: 'char', length: 3 })
  targetCurrency: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  sourceAmount: bigint;

  /** Credited amount, after the spread. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  targetAmount: bigint;

  /** Source amount valued at the mid rate; the difference is FX revenue. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  grossTargetAmount: bigint;

  @Column({ type: 'integer' })
  spreadBps: number;

  /** Snapshot of the mid rate used, with its orientation. */
  @Column({ type: 'char', length: 3 })
  rateBaseCurrency: string;

  @Column({ type: 'char', length: 3 })
  rateQuoteCurrency: string;

  @Column({ type: 'numeric', precision: 24, scale: 10 })
  rate: string;

  @Column({ type: 'timestamptz', precision: 3 })
  expiresAt: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  consumedAt: Date | null;

  @Index('uq_fx_quotes_conversion_reference', { unique: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
  conversionReference: string | null;

  @Column({ type: 'uuid', nullable: true })
  sourceTransactionId: string | null;

  @ManyToOne(() => LedgerTransaction, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'source_transaction_id',
    foreignKeyConstraintName: 'fk_fx_quotes_source_transaction',
  })
  sourceTransaction?: LedgerTransaction;

  @Column({ type: 'uuid', nullable: true })
  targetTransactionId: string | null;

  @ManyToOne(() => LedgerTransaction, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'target_transaction_id',
    foreignKeyConstraintName: 'fk_fx_quotes_target_transaction',
  })
  targetTransaction?: LedgerTransaction;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
