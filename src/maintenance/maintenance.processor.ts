import { InjectQueue, Processor } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Queue } from 'bullmq';
import { jobsConfig } from '../config/jobs.config';
import type { JobsConfig } from '../config/jobs.config';
import { ManagedWorker } from '../queues/managed-worker';
import { QueueName } from '../queues/queue-names';
import { CleanupResult, MaintenanceService } from './maintenance.service';

const CLEANUP_EVERY_MS = 60 * 60 * 1000;

/**
 * Hourly housekeeping. A BullMQ job scheduler (not setInterval) makes it run
 * once per interval across all instances.
 */
@Processor(QueueName.Maintenance, { autorun: false })
export class MaintenanceProcessor extends ManagedWorker {
  protected readonly workersEnabled: boolean;

  constructor(
    private readonly maintenance: MaintenanceService,
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
    }
  }

  process(): Promise<CleanupResult> {
    return this.maintenance.cleanup();
  }
}
