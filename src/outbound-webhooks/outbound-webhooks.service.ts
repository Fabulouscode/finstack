import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { SecretBox } from '../common/crypto/secret-box';
import type { Cursor } from '../common/pagination/cursor';
import { outboundWebhooksConfig } from '../config/outbound-webhooks.config';
import type { OutboundWebhooksConfig } from '../config/outbound-webhooks.config';
import type { DomainEventMessage } from '../outbox/outbox.service';
import { QueueName } from '../queues/queue-names';
import {
  WebhookDelivery,
  WebhookDeliveryStatus,
} from './webhook-delivery.entity';
import { WebhookEndpoint } from './webhook-endpoint.entity';
import {
  ALL_EVENTS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_TEST_EVENT,
} from './webhook-event-types';
import { WebhookSender } from './webhook-sender';
import { generateWebhookSecret } from './webhook-signature';
import { WebhookUrlPolicy } from './webhook-url-policy';
import {
  WebhookDeliveryNotFoundException,
  WebhookEndpointNotFoundException,
  WebhookUrlNotAllowedException,
} from './outbound-webhooks.errors';

export const DELIVER_JOB = 'deliver';

export interface DeliverJob {
  deliveryId: string;
}

export type DeliveryOutcome = 'succeeded' | 'retry' | 'failed' | 'skipped';

export interface DeliveryPage {
  deliveries: WebhookDelivery[];
  next: Cursor | null;
}

/**
 * Signed event callbacks to organizations' endpoints. Domain events fan out
 * to one delivery per subscribed endpoint (unique per event), which a worker
 * sends and retries with exponential backoff. Receivers get each event at
 * least once and dedupe on its `id`.
 */
@Injectable()
export class OutboundWebhooksService {
  private readonly logger = new Logger(OutboundWebhooksService.name);

  constructor(
    @InjectRepository(WebhookEndpoint)
    private readonly endpoints: Repository<WebhookEndpoint>,
    @InjectRepository(WebhookDelivery)
    private readonly deliveries: Repository<WebhookDelivery>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue(QueueName.OutboundWebhooks) private readonly queue: Queue,
    @Inject(outboundWebhooksConfig.KEY)
    private readonly config: OutboundWebhooksConfig,
    private readonly secrets: SecretBox,
    private readonly urlPolicy: WebhookUrlPolicy,
    private readonly sender: WebhookSender,
    private readonly audit: AuditService,
  ) {}

  // ---- Endpoints ----------------------------------------------------------------

  /** Returns the signing secret once; afterwards only rotation reveals a new one. */
  async create(
    organizationId: string,
    input: { url: string; eventTypes: string[]; description?: string },
  ): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    await this.assertUrlAllowed(input.url);
    const secret = generateWebhookSecret();
    const endpoint = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.save(
        manager.create(WebhookEndpoint, {
          organizationId,
          url: input.url,
          description: input.description ?? null,
          eventTypes: normaliseEventTypes(input.eventTypes),
          enabled: true,
          disabledReason: null,
          secretSealed: this.secrets.seal(secret),
          previousSecretSealed: null,
          previousSecretExpiresAt: null,
          consecutiveFailures: 0,
          deletedAt: null,
        }),
      );
      await this.audit.record(manager, {
        action: AuditAction.WebhookEndpointCreated,
        organizationId,
        targetType: 'webhook_endpoint',
        targetId: saved.id,
        metadata: { url: saved.url, eventTypes: saved.eventTypes },
      });
      return saved;
    });
    return { endpoint, secret };
  }

  list(organizationId: string): Promise<WebhookEndpoint[]> {
    return this.endpoints.find({
      where: { organizationId, deletedAt: IsNull() },
      order: { createdAt: 'ASC' },
    });
  }

  async get(
    organizationId: string,
    endpointId: string,
  ): Promise<WebhookEndpoint> {
    const endpoint = await this.endpoints.findOneBy({
      id: endpointId,
      organizationId,
      deletedAt: IsNull(),
    });
    if (!endpoint) {
      throw new WebhookEndpointNotFoundException();
    }
    return endpoint;
  }

  /** Re-enabling clears a system disable and the failure count. */
  async update(
    organizationId: string,
    endpointId: string,
    patch: {
      url?: string;
      eventTypes?: string[];
      description?: string | null;
      enabled?: boolean;
    },
  ): Promise<WebhookEndpoint> {
    const endpoint = await this.get(organizationId, endpointId);
    if (patch.url !== undefined) {
      await this.assertUrlAllowed(patch.url);
    }
    const changes: Partial<WebhookEndpoint> = {
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.eventTypes !== undefined
        ? { eventTypes: normaliseEventTypes(patch.eventTypes) }
        : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(patch.enabled !== undefined
        ? {
            enabled: patch.enabled,
            disabledReason: null,
            ...(patch.enabled ? { consecutiveFailures: 0 } : {}),
          }
        : {}),
    };
    await this.dataSource.transaction(async (manager) => {
      await manager.update(WebhookEndpoint, endpoint.id, changes);
      await this.audit.record(manager, {
        action: AuditAction.WebhookEndpointUpdated,
        organizationId,
        targetType: 'webhook_endpoint',
        targetId: endpoint.id,
        metadata: { ...patch },
      });
    });
    return this.get(organizationId, endpointId);
  }

  async remove(organizationId: string, endpointId: string): Promise<void> {
    const endpoint = await this.get(organizationId, endpointId);
    await this.dataSource.transaction(async (manager) => {
      await manager.update(WebhookEndpoint, endpoint.id, {
        deletedAt: new Date(),
        enabled: false,
      });
      await this.audit.record(manager, {
        action: AuditAction.WebhookEndpointDeleted,
        organizationId,
        targetType: 'webhook_endpoint',
        targetId: endpoint.id,
        metadata: { url: endpoint.url },
      });
    });
  }

  /**
   * Issues a new secret. The old one keeps signing (alongside) for
   * `graceHours`, so receivers can switch without dropping events.
   */
  async rotateSecret(
    organizationId: string,
    endpointId: string,
    graceHours: number,
  ): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    const endpoint = await this.get(organizationId, endpointId);
    const secret = generateWebhookSecret();
    await this.dataSource.transaction(async (manager) => {
      await manager.update(WebhookEndpoint, endpoint.id, {
        secretSealed: this.secrets.seal(secret),
        previousSecretSealed: graceHours > 0 ? endpoint.secretSealed : null,
        previousSecretExpiresAt:
          graceHours > 0
            ? new Date(Date.now() + graceHours * 60 * 60 * 1000)
            : null,
      });
      await this.audit.record(manager, {
        action: AuditAction.WebhookSecretRotated,
        organizationId,
        targetType: 'webhook_endpoint',
        targetId: endpoint.id,
        metadata: { graceHours },
      });
    });
    return { endpoint: await this.get(organizationId, endpointId), secret };
  }

  // ---- Deliveries ---------------------------------------------------------------

  /** Newest first, keyset-paginated. */
  async listDeliveries(
    organizationId: string,
    endpointId: string,
    options: {
      status?: WebhookDeliveryStatus;
      limit: number;
      before?: Cursor;
    },
  ): Promise<DeliveryPage> {
    await this.get(organizationId, endpointId);
    const query = this.deliveries
      .createQueryBuilder('delivery')
      .where('delivery.endpointId = :endpointId', { endpointId })
      .orderBy('delivery.createdAt', 'DESC')
      .addOrderBy('delivery.id', 'DESC')
      .limit(options.limit + 1);
    if (options.status) {
      query.andWhere('delivery.status = :status', { status: options.status });
    }
    if (options.before) {
      query.andWhere(
        '(delivery.createdAt, delivery.id) < (:beforeCreatedAt, :beforeId)',
        {
          beforeCreatedAt: options.before.createdAt,
          beforeId: options.before.id,
        },
      );
    }
    const rows = await query.getMany();
    const deliveries = rows.slice(0, options.limit);
    const last = deliveries.at(-1);
    return {
      deliveries,
      next:
        rows.length > options.limit && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }

  /** Sends a delivery again (e.g. after fixing the receiver). Same event id. */
  async redeliver(
    organizationId: string,
    endpointId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery> {
    await this.get(organizationId, endpointId);
    const delivery = await this.deliveries.findOneBy({
      id: deliveryId,
      endpointId,
    });
    if (!delivery) {
      throw new WebhookDeliveryNotFoundException();
    }
    await this.deliveries.update(delivery.id, {
      status: WebhookDeliveryStatus.Pending,
    });
    await this.enqueue(delivery.id, `${delivery.id}:${Date.now()}`);
    return this.deliveries.findOneByOrFail({ id: delivery.id });
  }

  /** Sends a `webhook.test` event, to check a receiver end to end. */
  async sendTest(
    organizationId: string,
    endpointId: string,
  ): Promise<WebhookDelivery> {
    const endpoint = await this.get(organizationId, endpointId);
    const eventId = randomUUID();
    const delivery = await this.deliveries.save(
      this.deliveries.create({
        endpointId: endpoint.id,
        eventId,
        eventType: WEBHOOK_TEST_EVENT,
        payload: envelope(eventId, WEBHOOK_TEST_EVENT, new Date(), {
          organizationId,
          message: 'Test event from FinStack',
        }),
        status: WebhookDeliveryStatus.Pending,
        attempts: 0,
        lastResponseStatus: null,
        lastError: null,
        lastAttemptAt: null,
        deliveredAt: null,
      }),
    );
    await this.enqueue(delivery.id);
    return delivery;
  }

  /**
   * Called for every domain event: creates a delivery per enabled endpoint
   * of the event's organization that subscribes to it. Idempotent.
   */
  async fanOut(event: DomainEventMessage): Promise<number> {
    const data = event.data as { organizationId?: unknown };
    if (
      typeof data.organizationId !== 'string' ||
      !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(event.type)
    ) {
      return 0;
    }
    const subscribed = await this.endpoints
      .createQueryBuilder('endpoint')
      .where('endpoint.organizationId = :organizationId', {
        organizationId: data.organizationId,
      })
      .andWhere('endpoint.enabled AND endpoint.deletedAt IS NULL')
      .andWhere(
        '(:type = ANY(endpoint.eventTypes) OR :all = ANY(endpoint.eventTypes))',
        {
          type: event.type,
          all: ALL_EVENTS,
        },
      )
      .getMany();

    let created = 0;
    for (const endpoint of subscribed) {
      const inserted = await this.deliveries
        .createQueryBuilder()
        .insert()
        .into(WebhookDelivery)
        .values({
          endpointId: endpoint.id,
          eventId: event.eventId,
          eventType: event.type,
          payload: envelope(
            event.eventId,
            event.type,
            new Date(event.occurredAt),
            event.data,
          ),
          status: WebhookDeliveryStatus.Pending,
          attempts: 0,
        })
        .orIgnore()
        .returning(['id'])
        .execute();
      const row = (inserted.raw as { id: string }[])[0];
      if (row) {
        await this.enqueue(row.id);
        created++;
      }
    }
    return created;
  }

  /**
   * One attempt, run by the worker. `retry` asks the queue to try again
   * later; on the last attempt a failure is final (and counts towards
   * disabling the endpoint).
   */
  async deliver(
    deliveryId: string,
    lastAttempt: boolean,
  ): Promise<DeliveryOutcome> {
    const delivery = await this.deliveries.findOneBy({ id: deliveryId });
    if (!delivery || delivery.status === WebhookDeliveryStatus.Succeeded) {
      return 'skipped';
    }
    const endpoint = await this.endpoints.findOneByOrFail({
      id: delivery.endpointId,
    });
    if (!endpoint.enabled || endpoint.deletedAt) {
      await this.deliveries.update(delivery.id, {
        status: WebhookDeliveryStatus.Failed,
        lastError: 'The endpoint is disabled',
      });
      return 'failed';
    }

    const refusal = await this.urlPolicy.check(endpoint.url);
    const result = refusal
      ? { ok: false as const, status: null, error: refusal }
      : await this.sender.send(
          endpoint.url,
          delivery,
          this.activeSecrets(endpoint),
        );

    if (result.ok) {
      await this.deliveries.update(delivery.id, {
        status: WebhookDeliveryStatus.Succeeded,
        attempts: delivery.attempts + 1,
        lastResponseStatus: result.status,
        lastError: null,
        lastAttemptAt: new Date(),
        deliveredAt: new Date(),
      });
      if (endpoint.consecutiveFailures > 0) {
        await this.endpoints.update(endpoint.id, { consecutiveFailures: 0 });
      }
      return 'succeeded';
    }

    await this.deliveries.update(delivery.id, {
      status: lastAttempt
        ? WebhookDeliveryStatus.Failed
        : WebhookDeliveryStatus.Pending,
      attempts: delivery.attempts + 1,
      lastResponseStatus: result.status,
      lastError: result.error.slice(0, 1000),
      lastAttemptAt: new Date(),
    });
    if (!lastAttempt) {
      return 'retry';
    }
    await this.recordFinalFailure(endpoint.id);
    return 'failed';
  }

  // ---- Helpers ------------------------------------------------------------------

  private activeSecrets(endpoint: WebhookEndpoint): string[] {
    const secrets = [this.secrets.open(endpoint.secretSealed)];
    if (
      endpoint.previousSecretSealed &&
      endpoint.previousSecretExpiresAt &&
      endpoint.previousSecretExpiresAt.getTime() > Date.now()
    ) {
      secrets.push(this.secrets.open(endpoint.previousSecretSealed));
    }
    return secrets;
  }

  /** Counts a final failure; too many in a row disables the endpoint. */
  private async recordFinalFailure(endpointId: string): Promise<void> {
    // For UPDATE ... RETURNING the driver yields [rows, affected].
    const [rows] = await this.dataSource.query<
      [{ consecutive_failures: number }[], number]
    >(
      `UPDATE webhook_endpoints
          SET consecutive_failures = consecutive_failures + 1
        WHERE id = $1
    RETURNING consecutive_failures`,
      [endpointId],
    );
    const failures = rows[0]?.consecutive_failures;
    if ((failures ?? 0) >= this.config.disableAfterFailures) {
      await this.endpoints.update(endpointId, {
        enabled: false,
        disabledReason: `Disabled after ${failures} failed deliveries in a row`,
      });
      this.logger.warn(
        `Webhook endpoint ${endpointId} disabled after ${failures} failed deliveries`,
      );
    }
  }

  private async enqueue(deliveryId: string, suffix?: string): Promise<void> {
    await this.queue.add(DELIVER_JOB, { deliveryId } satisfies DeliverJob, {
      jobId: `delivery-${suffix ?? deliveryId}`.replace(/:/g, '-'),
      attempts: this.config.maxAttempts,
      backoff: { type: 'exponential', delay: this.config.backoffMs },
    });
  }

  private async assertUrlAllowed(url: string): Promise<void> {
    const refusal = await this.urlPolicy.check(url);
    if (refusal) {
      throw new WebhookUrlNotAllowedException(refusal);
    }
  }
}

/** The request body receivers get. */
function envelope(
  id: string,
  type: string,
  createdAt: Date,
  data: object,
): object {
  return { id, type, createdAt: createdAt.toISOString(), data };
}

function normaliseEventTypes(types: string[]): string[] {
  const unique = [...new Set(types)];
  return unique.includes(ALL_EVENTS) ? [ALL_EVENTS] : unique.sort();
}
