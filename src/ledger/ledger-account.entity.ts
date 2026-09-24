import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../database/transformers';
import { EntryDirection, LedgerAccountType, sqlList } from './ledger.types';

@Entity({ name: 'ledger_accounts' })
@Check('chk_ledger_accounts_currency', `"currency" ~ '^[A-Z]{3}$'`)
@Check(
  'chk_ledger_accounts_type',
  `"type" IN (${sqlList(Object.values(LedgerAccountType))})`,
)
@Check(
  'chk_ledger_accounts_normal_balance',
  `"normal_balance" IN (${sqlList(Object.values(EntryDirection))})`,
)
// Last line of defence against overdrafts: holds even if application checks
// are bypassed or raced.
@Check(
  'chk_ledger_accounts_non_negative',
  `"allow_negative_balance" OR "balance" >= 0`,
)
export class LedgerAccount {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_ledger_accounts',
  })
  id: string;

  /** Stable identifier for system accounts, e.g. `system:psp-clearing:NGN`. */
  @Index('uq_ledger_accounts_code', { unique: true })
  @Column({ type: 'varchar', length: 100, nullable: true })
  code: string | null;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 20 })
  type: LedgerAccountType;

  @Column({ type: 'varchar', length: 10 })
  normalBalance: EntryDirection;

  @Column({ type: 'char', length: 3 })
  currency: string;

  /**
   * Cached balance in minor units, expressed on the account's normal side.
   * Maintained exclusively by a database trigger on ledger_entries inserts;
   * never written by the application (insert/update disabled).
   */
  @Column({
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
    insert: false,
    update: false,
  })
  balance: bigint;

  @Column({ type: 'boolean', default: false })
  allowNegativeBalance: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
