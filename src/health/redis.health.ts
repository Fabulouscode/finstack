import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { Queue } from 'bullmq';
import { QueueName } from '../queues/queue-names';

/** Readiness of Redis, which backs every queue. */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    @InjectQueue(QueueName.Webhooks) private readonly queue: Queue,
  ) {}

  pingCheck(
    key: string,
  ): ReturnType<ReturnType<HealthIndicatorService['check']>['attempt']> {
    return (
      this.health
        .check(key)
        // A real round-trip through BullMQ's public API; no raw client needed.
        .attempt(async () => {
          await this.queue.getJobCounts('waiting');
        })
        .withTimeout(1500)
    );
  }
}
