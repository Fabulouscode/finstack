import { createHmac } from 'node:crypto';
import { STRIPE_SIGNATURE_HEADER } from '../../payment-providers/stripe/stripe.provider';
import { Delivery, EventSource, FetchFn, getJson } from './event-source';

/** The events FinStack handles (see the deployment guide). */
export const STRIPE_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'refund.created',
  'refund.updated',
  'refund.failed',
];

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data?: {
    object?: {
      client_reference_id?: string;
      metadata?: Record<string, string>;
    };
  };
}

/**
 * Stripe's real events (`GET /v1/events`), delivered unchanged and signed
 * the way Stripe signs webhooks (`t=...,v1=HMAC-SHA256`), with the local
 * STRIPE_WEBHOOK_SECRET. No webhook endpoint needs to exist at Stripe.
 */
export class StripeSource implements EventSource {
  readonly provider = 'stripe';

  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn,
  ) {}

  async poll(since: Date): Promise<Delivery[]> {
    const query = new URLSearchParams({
      'created[gte]': String(Math.floor(since.getTime() / 1000)),
      limit: '100',
    });
    for (const type of STRIPE_EVENT_TYPES) query.append('types[]', type);
    const body = await getJson<{ data?: StripeEvent[] }>(
      this.fetchFn,
      `${this.baseUrl}/v1/events?${query.toString()}`,
      { Authorization: `Bearer ${this.secretKey}` },
    );
    // Stripe lists newest first; deliver in the order they happened.
    return [...(body.data ?? [])]
      .sort((a, b) => a.created - b.created)
      .map((event) => this.delivery(event));
  }

  private delivery(event: StripeEvent): Delivery {
    const body = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    const object = event.data?.object;
    return {
      key: `stripe:${event.id}`,
      provider: this.provider,
      type: event.type,
      reference:
        object?.client_reference_id ??
        object?.metadata?.finstack_reference ??
        event.id,
      body,
      headers: { [STRIPE_SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}` },
    };
  }
}
