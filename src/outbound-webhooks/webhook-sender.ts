import { Inject, Injectable } from '@nestjs/common';
import { request as httpRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { outboundWebhooksConfig } from '../config/outbound-webhooks.config';
import type { OutboundWebhooksConfig } from '../config/outbound-webhooks.config';
import { WebhookDelivery } from './webhook-delivery.entity';
import { SIGNATURE_HEADER, signatureHeader } from './webhook-signature';

export type SendResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string };

/** Where to connect: the approved address for the URL's host (DNS pinning). */
export interface PinnedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/** How much of a response body is read (for the error message). */
const MAX_RESPONSE_BYTES = 16 * 1024;

/**
 * One signed POST to a pinned address. The connection goes to the address
 * the URL policy checked; the request still carries the real host name
 * (Host header, TLS SNI and certificate verification). Any 2xx is success.
 * Redirects are not followed, since they could lead to internal addresses.
 */
@Injectable()
export class WebhookSender {
  constructor(
    @Inject(outboundWebhooksConfig.KEY)
    private readonly config: OutboundWebhooksConfig,
  ) {}

  async send(
    target: PinnedTarget,
    delivery: WebhookDelivery,
    secrets: string[],
  ): Promise<SendResult> {
    const body = JSON.stringify(delivery.payload);
    let response: { status: number; text: string };
    try {
      response = await this.post(target, body, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'User-Agent': 'FinStack-Webhooks/1.0',
        [SIGNATURE_HEADER]: signatureHeader(secrets, body),
        'FinStack-Event-Id': delivery.eventId,
        'FinStack-Event-Type': delivery.eventType,
        'FinStack-Delivery-Id': delivery.id,
      });
    } catch (error) {
      return {
        ok: false,
        status: null,
        error: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }
    return {
      ok: false,
      status: response.status,
      error:
        response.status >= 300 && response.status < 400
          ? `Redirects are not followed (HTTP ${response.status})`
          : `HTTP ${response.status}: ${response.text.slice(0, 300)}`,
    };
  }

  private post(
    { url, address, family }: PinnedTarget,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; text: string }> {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = request(
        {
          method: 'POST',
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          headers,
          // Pin the connection to the checked address; never resolve again.
          lookup: (_host, options, callback) => {
            if ((options as { all?: boolean }).all) {
              (
                callback as unknown as (
                  err: null,
                  addresses: { address: string; family: number }[],
                ) => void
              )(null, [{ address, family }]);
            } else {
              callback(null, address, family);
            }
          },
          signal: AbortSignal.timeout(this.config.timeoutMs),
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            if (size < MAX_RESPONSE_BYTES) {
              chunks.push(chunk);
              size += chunk.length;
            }
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }
}
