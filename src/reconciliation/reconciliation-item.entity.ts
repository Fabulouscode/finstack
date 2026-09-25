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
import { sqlList } from '../ledger/ledger.types';
import { ReconciliationRun } from './reconciliation-run.entity';

export enum ReconciliationItemKind {
  Payment = 'payment',
  Payout = 'payout',
  Ledger = 'ledger',
}

export enum ReconciliationIssue {
  /** The provider has money (or a transfer) FinStack has no record of. */
  MissingInFinstack = 'missing_in_finstack',
  /** The provider collected it; FinStack never credited it. */
  NotCredited = 'not_credited',
  /** FinStack credited it; the provider didn't collect it. */
  CreditedWithoutPayment = 'credited_without_payment',
  AmountMismatch = 'amount_mismatch',
  /** A payout's state differs from the provider's. */
  StatusMismatch = 'status_mismatch',
  /** A late webhook: settled by the run itself (auto-resolved). */
  LateSettlement = 'late_settlement',
  /** A ledger account's cached balance differs from its entries. */
  BalanceDiscrepancy = 'balance_discrepancy',
  /** Debits and credits of a currency don't balance. */
  TrialBalanceMismatch = 'trial_balance_mismatch',
}

export enum ReconciliationItemStatus {
  Open = 'open',
  Resolved = 'resolved',
  AutoResolved = 'auto_resolved',
}

/** A difference found by a reconciliation run, until someone resolves it. */
@Entity({ name: 'reconciliation_items' })
@Check(
  'chk_reconciliation_items_kind',
  `"kind" IN (${sqlList(Object.values(ReconciliationItemKind))})`,
)
@Check(
  'chk_reconciliation_items_issue',
  `"issue" IN (${sqlList(Object.values(ReconciliationIssue))})`,
)
@Check(
  'chk_reconciliation_items_status',
  `"status" IN (${sqlList(Object.values(ReconciliationItemStatus))})`,
)
@Index('idx_reconciliation_items_run', ['runId'])
@Index('idx_reconciliation_items_status_created_id', [
  'status',
  'createdAt',
  'id',
])
export class ReconciliationItem {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_reconciliation_items',
  })
  id: string;

  @Column({ type: 'uuid' })
  runId: string;

  @ManyToOne(() => ReconciliationRun, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'run_id',
    foreignKeyConstraintName: 'fk_reconciliation_items_run',
  })
  run?: ReconciliationRun;

  @Column({ type: 'varchar', length: 20 })
  kind: ReconciliationItemKind;

  @Column({ type: 'varchar', length: 50 })
  issue: ReconciliationIssue;

  /** Our reference (trx_/pyt_) or the provider's, or a ledger account id. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  reference: string | null;

  /** The FinStack record (payment, payout or ledger account), if any. */
  @Column({ type: 'uuid', nullable: true })
  targetId: string | null;

  /** What FinStack has. */
  @Column({ type: 'jsonb', nullable: true })
  finstack: Record<string, unknown> | null;

  /** What the provider reports. */
  @Column({ type: 'jsonb', nullable: true })
  provider: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 20 })
  status: ReconciliationItemStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  resolutionNote: string | null;

  @Column({ type: 'uuid', nullable: true })
  resolvedByUserId: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
