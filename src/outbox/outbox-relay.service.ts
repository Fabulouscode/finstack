import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { jobsConfig } from '../config/jobs.config';
import type { JobsConfig } from '../config/jobs.config';
import { OutboxEvent, OutboxEventStatus } from './outbox-event.entity';
import { OUTBOX_PUBLISHER } from './outbox-publisher';
import type { OutboxPublisher } from './outbox-publisher';

const BATCH_SIZE = 100;

/**
 * Moves committed outbox events to the queues.
 *
 * Each tick claims a batch with SELECT ... FOR UPDATE SKIP LOCKED, so any
 * number of app instances can relay concurrently without publishing the same
 * event twice at the same time. Delivery is at-least-once: consumers dedupe
 * by event id.
 */
@Injectable()
export class OutboxRelay
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OUTBOX_PUBLISHER) private readonly publisher: OutboxPublisher,
    @Inject(jobsConfig.KEY) private readonly config: JobsConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.workersEnabled) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.config.outboxPollIntervalMs,
    );
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** Publishes soon after a commit instead of waiting for the next poll. */
  nudge(): void {
    if (this.config.workersEnabled) {
      setImmediate(() => void this.tick());
    }
  }

  /** Relays one batch. Returns the number of events published. */
  async tick(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.relayBatch().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async relayBatch(): Promise<number> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const events = await manager
          .createQueryBuilder(OutboxEvent, 'event')
          .where('event.status = :status', {
            status: OutboxEventStatus.Pending,
          })
          .andWhere('event.availableAt <= now()')
          .orderBy('event.createdAt', 'ASC')
          .limit(BATCH_SIZE)
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked')
          .getMany();

        let published = 0;
        for (const event of events) {
          try {
            await this.publisher.publish(event);
            await manager.update(OutboxEvent, event.id, {
              status: OutboxEventStatus.Published,
              publishedAt: new Date(),
              publishAttempts: event.publishAttempts + 1,
              lastError: null,
            });
            published++;
          } catch (error) {
            const attempts = event.publishAttempts + 1;
            const delayMs = Math.min(60_000, 500 * 2 ** attempts);
            await manager.update(OutboxEvent, event.id, {
              publishAttempts: attempts,
              lastError: String(error).slice(0, 1000),
              availableAt: new Date(Date.now() + delayMs),
            });
            this.logger.warn(
              `Publishing outbox event ${event.id} failed (attempt ${attempts}): ${String(error)}`,
            );
          }
        }
        return published;
      });
    } catch (error) {
      this.logger.error(`Outbox relay tick failed: ${String(error)}`);
      return 0;
    }
  }
}
