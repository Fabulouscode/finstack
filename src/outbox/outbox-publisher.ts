import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { jobsConfig } from '../config/jobs.config';
import type { JobsConfig } from '../config/jobs.config';
import { QueueName } from '../queues/queue-names';
import { OutboxEvent } from './outbox-event.entity';
import { toMessage } from './outbox.service';

export const OUTBOX_PUBLISHER = Symbol('OUTBOX_PUBLISHER');

export interface OutboxPublisher {
  publish(event: OutboxEvent): Promise<void>;
}

/** Event types that are commands for a specific worker rather than broadcasts. */
export const WEBHOOK_RECEIVED = 'webhook.received';

/**
 * Routes outbox events to BullMQ. The job id is the outbox event id, so a
 * re-published event (e.g. after a crash between enqueue and commit) is
 * deduplicated by BullMQ while the job is retained.
 */
@Injectable()
export class BullmqOutboxPublisher implements OutboxPublisher {
  constructor(
    @InjectQueue(QueueName.Webhooks) private readonly webhooks: Queue,
    @InjectQueue(QueueName.DomainEvents) private readonly domainEvents: Queue,
    @Inject(jobsConfig.KEY) private readonly config: JobsConfig,
  ) {}

  async publish(event: OutboxEvent): Promise<void> {
    if (event.type === WEBHOOK_RECEIVED) {
      await this.webhooks.add('process', event.payload, {
        jobId: event.id,
        attempts: this.config.webhookMaxAttempts,
        backoff: {
          type: 'exponential',
          delay: this.config.webhookRetryBackoffMs,
        },
      });
      return;
    }

    await this.domainEvents.add(event.type, toMessage(event), {
      jobId: event.id,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
    });
  }
}
