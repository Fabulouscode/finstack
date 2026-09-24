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

/**
 * A balanced group of ledger entries, posted atomically. Immutable: errors
 * are corrected by posting a reversal, never by editing.
 */
@Entity({ name: 'ledger_transactions' })
@Check('chk_ledger_transactions_currency', `"currency" ~ '^[A-Z]{3}$'`)
@Check('chk_ledger_transactions_amount_positive', `"amount" > 0`)
// A transaction can be reversed at most once.
@Index('uq_ledger_transactions_reversal_of_id', ['reversalOfId'], {
  unique: true,
  where: '"reversal_of_id" IS NOT NULL',
})
export class LedgerTransaction {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_ledger_transactions',
  })
  id: string;

  /** Caller-supplied idempotency reference: one posting per reference, ever. */
  @Index('uq_ledger_transactions_reference', { unique: true })
  @Column({ type: 'varchar', length: 255 })
  reference: string;

  @Column({ type: 'varchar', length: 500 })
  description: string;

  @Column({ type: 'char', length: 3 })
  currency: string;

  /** Total of the debit side (equal to the credit side), in minor units. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column({ type: 'uuid', nullable: true })
  reversalOfId: string | null;

  @ManyToOne(() => LedgerTransaction, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'reversal_of_id',
    foreignKeyConstraintName: 'fk_ledger_transactions_reversal_of',
  })
  reversalOf?: LedgerTransaction;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, unknown>;

  // Millisecond precision so JavaScript Dates round-trip exactly, which keeps
  // keyset pagination cursors lossless.
  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
