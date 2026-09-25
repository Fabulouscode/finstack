import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';
import { paymentsConfig } from '../../config/payments.config';
import type { PaymentsConfig } from '../../config/payments.config';
import { JsonHttpClient } from '../http/json-http-client';
import {
  InitializePaymentInput,
  InitializePaymentResult,
  PaymentProvider,
  PaymentProviderError,
  ProviderPaymentStatus,
  ProviderWebhookEvent,
  RefundPaymentInput,
  RefundPaymentResult,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from '../payment-provider';

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

interface CheckoutSession {
  id: string;
  url: string | null;
  client_reference_id: string | null;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  amount_total: number | null;
  currency: string | null;
  payment_intent: string | null;
}

interface StripeEvent {
  id?: string;
  type?: string;
  data?: {
    object?: {
      id?: string;
      object?: string;
      client_reference_id?: string | null;
    };
  };
}

const SUCCEEDED_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);
const FAILED_EVENTS = new Set([
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);

/**
 * Stripe adapter using hosted Checkout Sessions (https://docs.stripe.com/api).
 *
 * FinStack's transaction reference is the session's `client_reference_id`
 * and the request's `Idempotency-Key`, so re-initialising after a timeout
 * returns the same session. The provider reference is the session id.
 */
@Injectable()
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  /** A conservative subset; check your Stripe account's presentment currencies. */
  readonly supportedCurrencies = [
    'USD',
    'EUR',
    'GBP',
    'JPY',
    'NGN',
    'KES',
    'ZAR',
  ] as const;

  constructor(
    @Inject(paymentsConfig.KEY) private readonly config: PaymentsConfig,
    private readonly http: JsonHttpClient,
  ) {}

  async initializePayment(
    input: InitializePaymentInput,
  ): Promise<InitializePaymentResult> {
    const session = await this.call<CheckoutSession>(
      'POST',
      '/v1/checkout/sessions',
      {
        form: {
          mode: 'payment',
          client_reference_id: input.reference,
          customer_email: input.customerEmail,
          success_url: input.callbackUrl ?? this.config.stripe.successUrl,
          cancel_url: this.config.stripe.cancelUrl,
          'line_items[0][quantity]': '1',
          'line_items[0][price_data][currency]': input.currency.toLowerCase(),
          // Stripe amounts are in the smallest currency unit, like ours
          // (and zero-decimal currencies such as JPY in whole units).
          'line_items[0][price_data][unit_amount]': input.amount.toString(),
          'line_items[0][price_data][product_data][name]': 'Wallet top-up',
          'metadata[finstack_reference]': input.reference,
          'payment_intent_data[metadata][finstack_reference]': input.reference,
        },
        idempotencyKey: `finstack-init-${input.reference}`,
      },
    );

    if (!session.url) {
      throw new PaymentProviderError(
        'Stripe returned a session without a URL',
        false,
      );
    }
    return { providerReference: session.id, authorizationUrl: session.url };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const session = await this.getSession(input.providerReference);
    if (session.client_reference_id !== input.reference) {
      throw new PaymentProviderError(
        'Stripe session belongs to another payment',
        false,
      );
    }

    const status: ProviderPaymentStatus =
      session.payment_status === 'paid'
        ? 'successful'
        : session.status === 'expired'
          ? 'failed'
          : 'pending';

    return {
      status,
      providerReference: session.id,
      amount: BigInt(session.amount_total ?? 0),
      currency: (session.currency ?? '').toUpperCase(),
      ...(status === 'failed'
        ? { failureReason: 'Checkout session expired' }
        : {}),
    };
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const session = await this.getSession(input.providerReference);
    if (!session.payment_intent) {
      throw new PaymentProviderError(
        'Stripe session has no payment to refund',
        false,
      );
    }
    const refund = await this.call<{ id: string; status: string }>(
      'POST',
      '/v1/refunds',
      {
        form: {
          payment_intent: session.payment_intent,
          amount: input.amount.toString(),
          'metadata[finstack_reference]': input.reference,
        },
        idempotencyKey: `finstack-refund-${input.reference}`,
      },
    );

    return {
      providerRefundReference: refund.id,
      status:
        refund.status === 'succeeded'
          ? 'successful'
          : refund.status === 'failed' || refund.status === 'canceled'
            ? 'failed'
            : 'pending',
    };
  }

  /**
   * Stripe-Signature: `t=<unix>,v1=<hex>[,v1=<hex>...]`, where each v1 is
   * HMAC-SHA256(webhookSecret, "<t>.<raw body>"). Signatures older than the
   * tolerance are rejected, so a captured webhook can't be replayed later.
   */
  verifyWebhookSignature(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): boolean {
    const header = headers[STRIPE_SIGNATURE_HEADER];
    if (typeof header !== 'string') return false;

    const parts = header.split(',').map((part) => part.split('=', 2));
    const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
    const signatures = parts
      .filter(
        ([key, value]) => key === 'v1' && value && /^[0-9a-f]{64}$/.test(value),
      )
      .map(([, value]) => Buffer.from(value ?? '', 'hex'));

    if (!Number.isInteger(timestamp) || signatures.length === 0) return false;
    const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
    if (ageSeconds > this.config.stripe.webhookToleranceSeconds) return false;

    const expected = createHmac('sha256', this.config.stripe.webhookSecret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest();
    return signatures.some((signature) => timingSafeEqual(signature, expected));
  }

  parseWebhookEvent(rawBody: Buffer): ProviderWebhookEvent {
    const event = JSON.parse(rawBody.toString('utf8')) as StripeEvent;
    const type = String(event.type);
    const object = event.data?.object;
    const isSession = object?.object === 'checkout.session';

    return {
      eventId: String(event.id),
      type: !isSession
        ? 'unknown'
        : SUCCEEDED_EVENTS.has(type)
          ? 'payment.succeeded'
          : FAILED_EVENTS.has(type)
            ? 'payment.failed'
            : 'unknown',
      providerType: type,
      providerReference: isSession ? object.id : undefined,
      reference: isSession
        ? (object.client_reference_id ?? undefined)
        : undefined,
    };
  }

  private getSession(sessionId: string): Promise<CheckoutSession> {
    return this.call<CheckoutSession>(
      'GET',
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { form?: Record<string, string>; idempotencyKey?: string } = {},
  ): Promise<T> {
    const response = await this.http.request<T>({
      method,
      url: `${this.config.stripe.baseUrl}${path}`,
      headers: {
        Authorization: `Bearer ${this.config.stripe.secretKey}`,
        ...(options.idempotencyKey
          ? { 'Idempotency-Key': options.idempotencyKey }
          : {}),
      },
      form: options.form,
      timeoutMs: this.config.stripe.timeoutMs,
    });
    return response.body;
  }
}
