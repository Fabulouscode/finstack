import { Processor } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { jobsConfig } from '../config/jobs.config';
import type { JobsConfig } from '../config/jobs.config';
import { ManagedWorker } from '../queues/managed-worker';
import { QueueName } from '../queues/queue-names';
import { WebhookEventStatus } from './webhook-event.entity';
import { WebhooksService } from './webhooks.service';

interface ProcessWebhookJob {
  webhookEventId: string;
}

/**
 * Settles stored webhook events. A failed attempt throws so BullMQ retries
 * with exponential backoff (WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_BACKOFF_MS).
 * When retries run out the event stays `failed`: the dead-letter state,
 * listed and replayable through the admin API.
 */
@Processor(QueueName.Webhooks, { autorun: false })
export class WebhooksProcessor extends ManagedWorker {
  protected readonly workersEnabled: boolean;
  private readonly logger = new Logger(WebhooksProcessor.name);

  constructor(
    private readonly webhooks: WebhooksService,
    @Inject(jobsConfig.KEY) config: JobsConfig,
  ) {
    super();
    this.workersEnabled = config.workersEnabled;
  }

  async process(job: Job<ProcessWebhookJob>): Promise<WebhookEventStatus> {
    const status = await this.webhooks.process(job.data.webhookEventId);
    if (status !== WebhookEventStatus.Failed) {
      return status;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade + 1 >= maxAttempts) {
      this.logger.error(
        `Webhook event ${job.data.webhookEventId} dead-lettered after ${maxAttempts} attempts; replay via the admin API`,
      );
    }
    throw new Error(
      `Webhook event ${job.data.webhookEventId} failed; retrying`,
    );
  }
}
