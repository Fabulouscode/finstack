import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { sqlList } from '../ledger/ledger.types';

export enum ReconciliationRunStatus {
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
}

export enum ReconciliationTrigger {
  Schedule = 'schedule',
  Manual = 'manual',
}

export interface ReconciliationSummary {
  paymentsChecked?: number;
  payoutsChecked?: number;
  issues?: number;
  autoResolved?: number;
  byIssue?: Record<string, number>;
}

/**
 * One comparison of FinStack's records with a provider's for a period, or,
 * with no provider, of the ledger with itself.
 */
@Entity({ name: 'reconciliation_runs' })
@Check(
  'chk_reconciliation_runs_status',
  `"status" IN (${sqlList(Object.values(ReconciliationRunStatus))})`,
)
@Check(
  'chk_reconciliation_runs_trigger',
  `"trigger" IN (${sqlList(Object.values(ReconciliationTrigger))})`,
)
@Check('chk_reconciliation_runs_period', `"period_end" > "period_start"`)
// The daily schedule runs each check once per period, even across instances.
@Index(
  'uq_reconciliation_runs_scheduled_provider',
  ['provider', 'periodStart'],
  {
    unique: true,
    where: `"trigger" = 'schedule' AND "provider" IS NOT NULL`,
  },
)
@Index('uq_reconciliation_runs_scheduled_ledger', ['periodStart'], {
  unique: true,
  where: `"trigger" = 'schedule' AND "provider" IS NULL`,
})
@Index('idx_reconciliation_runs_created', ['createdAt'])
export class ReconciliationRun {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_reconciliation_runs',
  })
  id: string;

  /** Null: the ledger's internal consistency checks. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  provider: string | null;

  @Column({ type: 'timestamptz', precision: 3 })
  periodStart: Date;

  /** Exclusive. */
  @Column({ type: 'timestamptz', precision: 3 })
  periodEnd: Date;

  @Column({ type: 'varchar', length: 20 })
  status: ReconciliationRunStatus;

  @Column({ type: 'varchar', length: 20 })
  trigger: ReconciliationTrigger;

  @Column({ type: 'uuid', nullable: true })
  requestedByUserId: string | null;

  @Column({ type: 'jsonb', default: {} })
  summary: ReconciliationSummary;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  error: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
