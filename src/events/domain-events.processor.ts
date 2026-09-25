import { Processor } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { jobsConfig } from '../config/jobs.config';
import type { JobsConfig } from '../config/jobs.config';
import { DomainEventMessage } from '../outbox/outbox.service';
import { ManagedWorker } from '../queues/managed-worker';
import { QueueName } from '../queues/queue-names';
import { DOMAIN_EVENT_HANDLERS } from './domain-event-handler';
import type { DomainEventHandler } from './domain-event-handler';

/** Fans each domain event out to its subscribed handlers. */
@Processor(QueueName.DomainEvents, { autorun: false })
export class DomainEventsProcessor extends ManagedWorker {
  protected readonly workersEnabled: boolean;

  constructor(
    @Inject(DOMAIN_EVENT_HANDLERS)
    private readonly handlers: DomainEventHandler[],
    @Inject(jobsConfig.KEY) config: JobsConfig,
  ) {
    super();
    this.workersEnabled = config.workersEnabled;
  }

  async process(job: Job<DomainEventMessage>): Promise<void> {
    const event = job.data;
    const subscribed = this.handlers.filter(
      (handler) =>
        handler.handles === '*' || handler.handles.includes(event.type),
    );
    // A failing handler fails the job, which is retried; handlers are idempotent.
    await Promise.all(subscribed.map((handler) => handler.handle(event)));
  }
}
