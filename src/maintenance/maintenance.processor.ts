import { InjectQueue, Processor } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { jobsConfig } from '../config/jobs.config';
import type { JobsConfig } from '../config/jobs.config';
import { SettlementReleaseService } from '../payments/settlement-release.service';
import { PayoutsService } from '../payouts/payouts.service';
import { ManagedWorker } from '../queues/managed-worker';
import { QueueName } from '../queues/queue-names';
import { CleanupResult, MaintenanceService } from './maintenance.service';

const CLEANUP_EVERY_MS = 60 * 60 * 1000;
const PAYOUT_SYNC_EVERY_MS = 5 * 60 * 1000;
const SETTLEMENT_RELEASE_EVERY_MS = 60 * 1000;
/** Payouts processing longer than this are re-checked with the provider. */
const PAYOUT_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Periodic housekeeping: hourly cleanup, ending settlement holds every
 * minute, and re-checking payouts stuck in processing (lost webhooks,
 * provider outages) every few minutes. A BullMQ job scheduler (not setInterval) makes it run
 * once per interval across all instances.
 */
@Processor(QueueName.Maintenance, { autorun: false })
export class MaintenanceProcessor extends ManagedWorker {
  protected readonly workersEnabled: boolean;

  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly payouts: PayoutsService,
    private readonly settlement: SettlementReleaseService,
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
    }
  }

  async process(
    job: Job,
  ): Promise<CleanupResult | { synced: number } | { released: number }> {
    if (job.name === 'settlement-release') {
      return { released: await this.settlement.releaseDue() };
    }
    if (job.name === 'payouts-sync') {
      return { synced: await this.payouts.syncStale(PAYOUT_STALE_AFTER_MS) };
    }
    return this.maintenance.cleanup();
  }
}
