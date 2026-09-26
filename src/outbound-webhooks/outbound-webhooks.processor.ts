import { Processor } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { jobsConfig } from '../config/jobs.config';
import type { JobsConfig } from '../config/jobs.config';
import { MetricsService } from '../observability/metrics.service';
import { ManagedWorker } from '../queues/managed-worker';
import { QueueName } from '../queues/queue-names';
import {
  DeliverJob,
  DeliveryOutcome,
  OutboundWebhooksService,
} from './outbound-webhooks.service';

/**
 * Sends webhook deliveries. A failed attempt throws so BullMQ retries with
 * exponential backoff; after the last attempt the delivery stays `failed`
 * and can be redelivered through the API.
 */
@Processor(QueueName.OutboundWebhooks, { autorun: false, concurrency: 10 })
export class OutboundWebhooksProcessor extends ManagedWorker {
  protected readonly workersEnabled: boolean;
  private readonly logger = new Logger(OutboundWebhooksProcessor.name);

  constructor(
    private readonly webhooks: OutboundWebhooksService,
    private readonly metrics: MetricsService,
    @Inject(jobsConfig.KEY) config: JobsConfig,
  ) {
    super();
    this.workersEnabled = config.workersEnabled;
  }

  async process(job: Job<DeliverJob>): Promise<DeliveryOutcome> {
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const outcome = await this.webhooks.deliver(
      job.data.deliveryId,
      lastAttempt,
    );
    if (outcome === 'retry') {
      throw new Error(`Delivery ${job.data.deliveryId} failed; retrying`);
    }
    if (outcome === 'failed') {
      this.logger.warn(`Delivery ${job.data.deliveryId} failed permanently`);
    }
    return outcome;
  }
}
