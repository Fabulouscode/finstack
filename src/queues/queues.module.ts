import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { RedisConfig, redisConfig } from '../config/redis.config';
import { ALL_QUEUES } from './queue-names';

/**
 * Redis connection and queue registrations. Import wherever a queue is
 * injected (@InjectQueue) or processed (@Processor).
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (config: RedisConfig) => ({
        connection: config.connection,
        prefix: config.queuePrefix,
        defaultJobOptions: {
          // Keep finished jobs long enough to inspect and to dedupe
          // re-published outbox events by job id.
          removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      }),
    }),
    BullModule.registerQueue(...ALL_QUEUES.map((name) => ({ name }))),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
