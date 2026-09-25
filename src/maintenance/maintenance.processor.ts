import { InjectQueue, Processor } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { jobsConfig } from '../config/jobs.config';
import type { JobsConfig } from '../config/jobs.config';
import { SettlementReleaseService } from '../payments/settlement-release.service';
import { RECONCILIATION_JOB } from '../reconciliation/reconciliation-jobs';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { PayoutsService } from '../payouts/payouts.service';
import { ManagedWorker } from '../queues/managed-worker';
import { QueueName } from '../queues/queue-names';
import { CleanupResult, MaintenanceService } from './maintenance.service';

const CLEANUP_EVERY_MS = 60 * 60 * 1000;
const PAYOUT_SYNC_EVERY_MS = 5 * 60 * 1000;
const SETTLEMENT_RELEASE_EVERY_MS = 60 * 1000;
/** Daily, for the previous UTC day, once providers have closed it. */
const RECONCILIATION_CRON = '0 2 * * *';
/** Payouts processing longer than this are re-checked with the provider. */
const PAYOUT_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Periodic and background housekeeping: hourly cleanup, ending settlement
 * holds every minute, re-checking payouts stuck in processing (lost
 * webhooks, provider outages) every few minutes, and reconciliation (daily,
 * or on request). A BullMQ job scheduler (not setInterval) makes it run
 * once per interval across all instances.
 */
@Processor(QueueName.Maintenance, { autorun: false })
export class MaintenanceProcessor extends ManagedWorker {
  protected readonly workersEnabled: boolean;

  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly payouts: PayoutsService,
    private readonly settlement: SettlementReleaseService,
    private readonly reconciliation: ReconciliationService,
    @InjectQueue(QueueName.Maintenance) private readonly queue: Queue,
    @Inject(jobsConfig.KEY) config: JobsConfig,
  ) {
    super();
    this.workersEnabled = config.workersEnabled;
  }

  override onApplicationBootstrap(): void {
    super.onApplicationBootstrap();
    if (this.workersEnabled) {
      void this.queue.upsertJobScheduler(
        'cleanup',
        { every: CLEANUP_EVERY_MS },
        { name: 'cleanup' },
      );
      void this.queue.upsertJobScheduler(
        'payouts-sync',
        { every: PAYOUT_SYNC_EVERY_MS },
        { name: 'payouts-sync' },
      );
      void this.queue.upsertJobScheduler(
        'settlement-release',
        { every: SETTLEMENT_RELEASE_EVERY_MS },
        { name: 'settlement-release' },
      );
      void this.queue.upsertJobScheduler(
        'reconciliation-daily',
        { pattern: RECONCILIATION_CRON, tz: 'UTC' },
        { name: 'reconciliation-daily' },
      );
    }
  }

  async process(
    job: Job<{ runId?: string }>,
  ): Promise<
    CleanupResult | { synced: number } | { released: number } | { runs: number }
  > {
    if (job.name === RECONCILIATION_JOB && job.data.runId) {
      await this.reconciliation.execute(job.data.runId);
      return { runs: 1 };
    }
    if (job.name === 'reconciliation-daily') {
      return { runs: (await this.reconciliation.runScheduled()).length };
    }
    if (job.name === 'settlement-release') {
      return { released: await this.settlement.releaseDue() };
    }
    if (job.name === 'payouts-sync') {
      return { synced: await this.payouts.syncStale(PAYOUT_STALE_AFTER_MS) };
    }
    return this.maintenance.cleanup();
  }
}
