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
import { LedgerAccount } from './ledger-account.entity';
import { LedgerTransaction } from './ledger-transaction.entity';
import { EntryDirection, sqlList } from './ledger.types';

@Entity({ name: 'ledger_entries' })
@Check('chk_ledger_entries_amount_positive', `"amount" > 0`)
@Check(
  'chk_ledger_entries_direction',
  `"direction" IN (${sqlList(Object.values(EntryDirection))})`,
)
@Index('idx_ledger_entries_ledger_transaction_id', ['ledgerTransactionId'])
// Serves account history: WHERE ledger_account_id = $1 ORDER BY created_at
// DESC, id DESC with keyset pagination. See docs/performance/.
@Index('idx_ledger_entries_account_created_id', [
  'ledgerAccountId',
  'createdAt',
  'id',
])
export class LedgerEntry {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_ledger_entries',
  })
  id: string;

  @Column({ type: 'uuid' })
  ledgerTransactionId: string;

  @ManyToOne(() => LedgerTransaction, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'ledger_transaction_id',
    foreignKeyConstraintName: 'fk_ledger_entries_ledger_transaction',
  })
  ledgerTransaction?: LedgerTransaction;

  @Column({ type: 'uuid' })
  ledgerAccountId: string;

  @ManyToOne(() => LedgerAccount, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'ledger_account_id',
    foreignKeyConstraintName: 'fk_ledger_entries_ledger_account',
  })
  ledgerAccount?: LedgerAccount;

  @Column({ type: 'varchar', length: 10 })
  direction: EntryDirection;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column({ type: 'char', length: 3 })
  currency: string;

  // Millisecond precision so JavaScript Dates round-trip exactly, which keeps
  // keyset pagination cursors lossless.
  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
