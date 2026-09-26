import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import { DataSource } from 'typeorm';
import { OutboxService } from '../outbox/outbox.service';
import { QueueName } from '../queues/queue-names';

/**
 * Prometheus metrics. Each app instance has its own registry (not the
 * global one), so tests can boot several apps in one process.
 *
 * Labels are kept to bounded values (route templates, event types,
 * outcomes), never ids or amounts, so series don't explode.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly httpRequests = new Counter({
    name: 'finstack_http_requests_total',
    help: 'HTTP requests by method, route template and status code',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });

  private readonly httpDuration = new Histogram({
    name: 'finstack_http_request_duration_seconds',
    help: 'HTTP request duration by method and route template',
    labelNames: ['method', 'route'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  private readonly domainEvents = new Counter({
    name: 'finstack_domain_events_total',
    help: 'Domain events processed, by type (e.g. payment.successful)',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  private readonly inboundWebhooks = new Counter({
    name: 'finstack_provider_webhooks_total',
    help: 'Provider webhooks processed, by provider and resulting status',
    labelNames: ['provider', 'status'] as const,
    registers: [this.registry],
  });

  private readonly outboundDeliveries = new Counter({
    name: 'finstack_webhook_delivery_attempts_total',
    help: 'Outbound webhook delivery attempts, by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  constructor(
    @InjectDataSource() dataSource: DataSource,
    outbox: OutboxService,
    @InjectQueue(QueueName.Webhooks) webhooks: Queue,
    @InjectQueue(QueueName.DomainEvents) domainEvents: Queue,
    @InjectQueue(QueueName.OutboundWebhooks) outboundWebhooks: Queue,
    @InjectQueue(QueueName.Maintenance) maintenance: Queue,
  ) {
    collectDefaultMetrics({ register: this.registry, prefix: 'finstack_' });

    const queues = [webhooks, domainEvents, outboundWebhooks, maintenance];
    new Gauge({
      name: 'finstack_queue_jobs',
      help: 'Jobs per queue and state (read when scraped)',
      labelNames: ['queue', 'state'] as const,
      registers: [this.registry],
      async collect() {
        this.reset();
        for (const queue of queues) {
          const counts = await queue.getJobCounts(
            'waiting',
            'active',
            'delayed',
            'failed',
          );
          for (const [state, count] of Object.entries(counts)) {
            this.set({ queue: queue.name, state }, count);
          }
        }
      },
    });

    new Gauge({
      name: 'finstack_outbox_pending_events',
      help: 'Domain events not yet published to the queue (read when scraped)',
      registers: [this.registry],
      async collect() {
        this.set(await outbox.countPendingWithin(dataSource.manager));
      },
    });
  }

  observeHttp(
    method: string,
    route: string,
    status: number,
    seconds: number,
  ): void {
    this.httpRequests.inc({ method, route, status: String(status) });
    this.httpDuration.observe({ method, route }, seconds);
  }

  countDomainEvent(type: string): void {
    this.domainEvents.inc({ type });
  }

  countProviderWebhook(provider: string, status: string): void {
    this.inboundWebhooks.inc({ provider, status });
  }

  countDeliveryAttempt(outcome: string): void {
    this.outboundDeliveries.inc({ outcome });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
