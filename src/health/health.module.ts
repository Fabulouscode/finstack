import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { QueuesModule } from '../queues/queues.module';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './redis.health';

@Module({
  imports: [TerminusModule, QueuesModule],
  controllers: [HealthController],
  providers: [RedisHealthIndicator],
})
export class HealthModule {}
