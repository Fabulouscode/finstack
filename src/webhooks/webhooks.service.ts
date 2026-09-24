import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IncomingHttpHeaders } from 'node:http';
import { Repository } from 'typeorm';
import { AppException } from '../common/http/app.exception';
import { PaymentProvidersService } from '../payment-providers/payment-providers.service';
import { PaymentSettlementService } from '../payments/payment-settlement.service';
import { PaymentsService } from '../payments/payments.service';
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
    private readonly providers: PaymentProvidersService,
    private readonly payments: PaymentsService,
    private readonly settlement: PaymentSettlementService,
  ) {}

  /**
   * Verifies, stores and processes a provider webhook.
   *
   * Nothing is stored or acted upon unless the signature over the exact raw
   * body is valid. Duplicate deliveries (same provider event id) are
   * acknowledged without reprocessing.
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

    const inserted = await this.events
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
      return { eventId: parsed.eventId, duplicate: true };
    }

    await this.process(row.id);
    return { eventId: parsed.eventId, duplicate: false };
  }

  /**
   * Applies a stored event. Errors are recorded on the event (never thrown
   * to the provider): the event is persisted, so it can be retried or
   * replayed without depending on the provider redelivering it.
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
    try {
      const payment =
        event.type !== 'unknown' && event.providerReference
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
        return WebhookEventStatus.Ignored;
      }

      const outcome = await this.settlement.settle(payment);
      await this.finish(
        event.id,
        WebhookEventStatus.Processed,
        attempts,
        outcome,
      );
      return WebhookEventStatus.Processed;
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
      return WebhookEventStatus.Failed;
    }
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
