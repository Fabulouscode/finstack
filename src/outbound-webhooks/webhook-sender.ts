import { Inject, Injectable } from '@nestjs/common';
import { outboundWebhooksConfig } from '../config/outbound-webhooks.config';
import type { OutboundWebhooksConfig } from '../config/outbound-webhooks.config';
import { WebhookDelivery } from './webhook-delivery.entity';
import { SIGNATURE_HEADER, signatureHeader } from './webhook-signature';

export type SendResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string };

/**
 * One signed POST. Any 2xx is success. Redirects are not followed (they
 * could lead to internal addresses); receivers should respond quickly and
 * process asynchronously.
 */
@Injectable()
export class WebhookSender {
  constructor(
    @Inject(outboundWebhooksConfig.KEY)
    private readonly config: OutboundWebhooksConfig,
  ) {}

  async send(
    url: string,
    delivery: WebhookDelivery,
    secrets: string[],
  ): Promise<SendResult> {
    const body = JSON.stringify(delivery.payload);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'FinStack-Webhooks/1.0',
          [SIGNATURE_HEADER]: signatureHeader(secrets, body),
          'FinStack-Event-Id': delivery.eventId,
          'FinStack-Event-Type': delivery.eventType,
          'FinStack-Delivery-Id': delivery.id,
        },
        body,
      });
    } catch (error) {
      return {
        ok: false,
        status: null,
        error: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    // Drain the body (bounded by the timeout) so the connection is released.
    const text = await response.text().catch(() => '');
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }
    return {
      ok: false,
      status: response.status,
      error:
        response.status >= 300 && response.status < 400
          ? `Redirects are not followed (HTTP ${response.status})`
          : `HTTP ${response.status}: ${text.slice(0, 300)}`,
    };
  }
}
