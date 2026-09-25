import { OnApplicationBootstrap } from '@nestjs/common';
import { WorkerHost } from '@nestjs/bullmq';

/**
 * Base for queue processors registered with `autorun: false`: they start
 * only when WORKERS_ENABLED is true, so API-only instances (or tests that
 * don't need workers) never consume jobs.
 */
export abstract class ManagedWorker
  extends WorkerHost
  implements OnApplicationBootstrap
{
  protected abstract readonly workersEnabled: boolean;

  onApplicationBootstrap(): void {
    if (this.workersEnabled && !this.worker.isRunning()) {
      void this.worker.run();
    }
  }
}
