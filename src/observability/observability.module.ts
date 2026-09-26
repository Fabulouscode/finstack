import { Global, Module } from '@nestjs/common';
import { observabilityConfig } from '../config/observability.config';
import type { ObservabilityConfig } from '../config/observability.config';
import { OutboxModule } from '../outbox/outbox.module';
import { QueuesModule } from '../queues/queues.module';
import { AppLogger } from './app-logger';
import { MetricsController } from './metrics.controller';
import { MetricsEventHandler } from './metrics.event-handler';
import { MetricsService } from './metrics.service';

/** Logs and metrics. Global, so any module can record a metric. */
@Global()
@Module({
  imports: [OutboxModule, QueuesModule],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    MetricsEventHandler,
    {
      provide: AppLogger,
      inject: [observabilityConfig.KEY],
      useFactory: (config: ObservabilityConfig) => new AppLogger(config),
    },
  ],
  exports: [MetricsService, MetricsEventHandler, AppLogger],
})
export class ObservabilityModule {}
