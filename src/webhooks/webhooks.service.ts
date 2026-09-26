import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { IncomingHttpHeaders } from 'node:http';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/http/app.exception';
import { MetricsService } from '../observability/metrics.service';
import { WEBHOOK_RECEIVED } from '../outbox/outbox-publisher';
import { OutboxRelay } from '../outbox/outbox-relay.service';
import { OutboxService } from '../outbox/outbox.service';
import { PaymentProvidersService } from '../payment-providers/payment-providers.service';
import { PaymentSettlementService } from '../payments/payment-settlement.service';
import { PaymentsService } from '../payments/payments.service';
import { PayoutsService } from '../payouts/payouts.service';
import { RefundsService } from '../refunds/refunds.service';
import { WebhookEvent, WebhookEventStatus } from './webhook-event.entity';

export class InvalidWebhookSignatureException extends AppException {
  constructor() {
    super(
      'INVALID_WEBHOOK_SIGNATURE',
      'Webhook signature verification failed',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class InvalidWebhookPayloadException extends AppException {
  constructor() {
    super(
      'INVALID_WEBHOOK_PAYLOAD',
      'Webhook body is not a valid event',
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class WebhookEventNotReplayableException extends AppException {
  constructor() {
    super(
      'WEBHOOK_EVENT_NOT_REPLAYABLE',
      'Only failed or ignored webhook events can be replayed',
      HttpStatus.CONFLICT,
    );
  }
}

export class WebhookEventNotFoundException extends AppException {
  constructor() {
    super(
      'WEBHOOK_EVENT_NOT_FOUND',
      'Webhook event not found',
      HttpStatus.NOT_FOUND,
    );
  }
}

export interface ReceiveResult {
  eventId: string;
  duplicate: boolean;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @InjectRepository(WebhookEvent)
    private readonly events: Repository<WebhookEvent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
    private readonly relay: OutboxRelay,
    private readonly providers: PaymentProvidersService,
    private readonly payments: PaymentsService,
    private readonly settlement: PaymentSettlementService,
    private readonly refunds: RefundsService,
    private readonly payouts: PayoutsService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Verifies and stores a provider webhook, and schedules its processing.
   *
   * Nothing is stored or acted upon unless the signature over the exact raw
   * body is valid. Duplicate deliveries (same provider event id) are
   * acknowledged without reprocessing. The event and its processing job
   * (an outbox row) commit together, so a stored webhook is never lost even
   * if Redis is down: the relay publishes it once Redis is back.
   */
  async receive(
    providerName: string,
    rawBody: Buffer | undefined,
    headers: IncomingHttpHeaders,
  ): Promise<ReceiveResult> {
    const provider = this.providers.get(providerName);
    if (!rawBody || !provider.verifyWebhookSignature(rawBody, headers)) {
      this.logger.warn(
        `Rejected ${providerName} webhook with an invalid signature`,
      );
      throw new InvalidWebhookSignatureException();
    }

    let parsed: ReturnType<typeof provider.parseWebhookEvent>;
    let payload: object;
    try {
      parsed = provider.parseWebhookEvent(rawBody);
      payload = JSON.parse(rawBody.toString('utf8')) as object;
    } catch {
      throw new InvalidWebhookPayloadException();
    }
    if (!parsed.eventId || parsed.eventId === 'undefined') {
      throw new InvalidWebhookPayloadException();
    }

    const storedId = await this.dataSource.transaction(async (manager) => {
      const inserted = await manager
        .createQueryBuilder()
        .insert()
        .into(WebhookEvent)
        .values({
          provider: providerName,
          eventId: parsed.eventId,
          type: parsed.type,
          providerType: parsed.providerType.slice(0, 100),
          providerReference: parsed.providerReference ?? null,
          payload,
          status: WebhookEventStatus.Received,
          attempts: 0,
        })
        .orIgnore()
        .returning(['id'])
        .execute();

      const row = (inserted.raw as { id: string }[])[0];
      if (!row) {
        return null;
      }
      await this.scheduleProcessing(manager, row.id);
      return row.id;
    });

    if (!storedId) {
      return { eventId: parsed.eventId, duplicate: true };
    }
    this.relay.nudge();
    return { eventId: parsed.eventId, duplicate: false };
  }

  /**
   * Applies a stored event (run by the webhooks worker). Errors are recorded
   * on the event and reported as `failed`, which makes the worker retry with
   * exponential backoff; the provider is never involved in retries.
   */
  async process(webhookEventId: string): Promise<WebhookEventStatus> {
    const event = await this.events.findOneByOrFail({ id: webhookEventId });
    if (
      event.status === WebhookEventStatus.Processed ||
      event.status === WebhookEventStatus.Ignored
    ) {
      return event.status;
    }

    const attempts = event.attempts + 1;
    const counted = (status: WebhookEventStatus): WebhookEventStatus => {
      this.metrics.countProviderWebhook(event.provider, status);
      return status;
    };
    try {
      if (
        (event.type === 'refund.succeeded' || event.type === 'refund.failed') &&
        event.providerReference
      ) {
        // Re-checks matching refunds with the provider; the payload itself
        // is only a hint of which refunds to look at.
        const synced = await this.refunds.syncFromWebhook(
          event.provider,
          event.providerReference,
        );
        const status =
          synced > 0
            ? WebhookEventStatus.Processed
            : WebhookEventStatus.Ignored;
        await this.finish(
          event.id,
          status,
          attempts,
          synced > 0 ? 'refunds_synced' : 'no_matching_refund',
        );
        return counted(status);
      }

      if (event.type.startsWith('payout.') && event.providerReference) {
        // Re-checked with the provider; the payload only says which payout.
        const found = await this.payouts.syncFromWebhook(
          event.provider,
          event.providerReference,
        );
        const status = found
          ? WebhookEventStatus.Processed
          : WebhookEventStatus.Ignored;
        await this.finish(
          event.id,
          status,
          attempts,
          found ? 'payout_synced' : 'no_matching_payout',
        );
        return counted(status);
      }

      const payment =
        event.type.startsWith('payment.') && event.providerReference
          ? await this.payments.findByProviderReference(
              event.provider,
              event.providerReference,
            )
          : null;

      if (!payment) {
        await this.finish(
          event.id,
          WebhookEventStatus.Ignored,
          attempts,
          'no_matching_payment',
        );
        return counted(WebhookEventStatus.Ignored);
      }

      const outcome = await this.settlement.settle(payment);
      await this.finish(
        event.id,
        WebhookEventStatus.Processed,
        attempts,
        outcome,
      );
      return counted(WebhookEventStatus.Processed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Processing webhook event ${event.id} failed: ${message}`,
      );
      await this.events.update(event.id, {
        status: WebhookEventStatus.Failed,
        attempts,
        lastError: message.slice(0, 1000),
      });
      return counted(WebhookEventStatus.Failed);
    }
  }

  /**
   * Re-runs a failed (dead-lettered) or ignored event, e.g. after fixing the
   * cause. Settlement is idempotent, so replaying can never double-credit.
   */
  async replay(webhookEventId: string): Promise<WebhookEvent> {
    await this.dataSource.transaction(async (manager) => {
      const event = await manager
        .createQueryBuilder(WebhookEvent, 'event')
        .setLock('pessimistic_write')
        .where('event.id = :id', { id: webhookEventId })
        .getOne();
      if (!event) {
        throw new WebhookEventNotFoundException();
      }
      if (
        event.status !== WebhookEventStatus.Failed &&
        event.status !== WebhookEventStatus.Ignored
      ) {
        throw new WebhookEventNotReplayableException();
      }
      await manager.update(WebhookEvent, event.id, {
        status: WebhookEventStatus.Received,
      });
      await this.scheduleProcessing(manager, event.id);
      await this.audit.record(manager, {
        action: AuditAction.WebhookReplayed,
        targetType: 'webhook_event',
        targetId: event.id,
        metadata: {
          provider: event.provider,
          eventId: event.eventId,
          previousStatus: event.status,
        },
      });
    });
    this.relay.nudge();
    return this.events.findOneByOrFail({ id: webhookEventId });
  }

  countByStatus(status: WebhookEventStatus): Promise<number> {
    return this.events.countBy({ status });
  }

  list(options: {
    status?: WebhookEventStatus;
    limit: number;
  }): Promise<WebhookEvent[]> {
    return this.events.find({
      where: options.status ? { status: options.status } : {},
      order: { receivedAt: 'DESC' },
      take: options.limit,
    });
  }

  private async scheduleProcessing(
    manager: EntityManager,
    webhookEventId: string,
  ): Promise<void> {
    await this.outbox.add(manager, {
      type: WEBHOOK_RECEIVED,
      aggregateType: 'webhook_event',
      aggregateId: webhookEventId,
      payload: { webhookEventId },
    });
  }

  private async finish(
    id: string,
    status: WebhookEventStatus,
    attempts: number,
    outcome: string,
  ): Promise<void> {
    await this.events.update(id, {
      status,
      attempts,
      outcome,
      lastError: null,
      processedAt: new Date(),
    });
  }
}
