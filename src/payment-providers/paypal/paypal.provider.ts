import { Inject, Injectable } from '@nestjs/common';
import { X509Certificate, createVerify } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';
import { crc32 } from 'node:zlib';
import {
  fromMajorUnits,
  toMajorUnitString,
} from '../../common/money/major-units';
import { paymentsConfig } from '../../config/payments.config';
import type { PaymentsConfig } from '../../config/payments.config';
import { JsonHttpClient } from '../http/json-http-client';
import {
  CreateEmailRecipientInput,
  FindRefundInput,
  InitializePaymentInput,
  InitializePaymentResult,
  PaymentProvider,
  PaymentProviderError,
  PayoutCapability,
  PayoutRecipient,
  PayoutResult,
  ProviderEventType,
  ProviderPaymentStatus,
  ProviderPayoutStatus,
  ProviderWebhookEvent,
  RefundPaymentInput,
  RefundPaymentResult,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from '../payment-provider';

/** Refunds checked one by one when looking for ours; more is refused. */
const FIND_REFUND_MAX = 50;

interface Money {
  currency_code: string;
  value: string;
}

interface Capture {
  id: string;
  status: string;
  amount?: Money;
  custom_id?: string;
}

interface RefundSummary {
  id: string;
  status: string;
  custom_id?: string;
}

interface Order {
  id: string;
  status: string;
  links?: { href: string; rel: string }[];
  purchase_units?: {
    reference_id?: string;
    custom_id?: string;
    amount?: Money;
    payments?: { captures?: Capture[]; refunds?: RefundSummary[] };
  }[];
}

interface PayoutBatch {
  batch_header: {
    payout_batch_id: string;
    batch_status: string;
    sender_batch_header?: { sender_batch_id?: string };
  };
  items?: {
    transaction_status?: string;
    errors?: { name?: string; message?: string };
    payout_item?: { sender_item_id?: string };
  }[];
}

interface PayPalEvent {
  id?: string;
  event_type?: string;
  resource?: {
    id?: string;
    custom_id?: string;
    purchase_units?: { reference_id?: string }[];
    supplementary_data?: { related_ids?: { order_id?: string } };
    payout_item?: { sender_item_id?: string };
    batch_header?: { sender_batch_header?: { sender_batch_id?: string } };
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EVENT_TYPES: Record<string, ProviderEventType> = {
  'CHECKOUT.ORDER.APPROVED': 'payment.approved',
  'PAYMENT.CAPTURE.COMPLETED': 'payment.succeeded',
  'PAYMENT.CAPTURE.DENIED': 'payment.failed',
  'PAYMENT.CAPTURE.DECLINED': 'payment.failed',
  'PAYMENT.CAPTURE.REFUNDED': 'refund.succeeded',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': 'payout.succeeded',
  'PAYMENT.PAYOUTS-ITEM.FAILED': 'payout.failed',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED': 'payout.failed',
  'PAYMENT.PAYOUTS-ITEM.DENIED': 'payout.failed',
  'PAYMENT.PAYOUTS-ITEM.CANCELED': 'payout.failed',
  'PAYMENT.PAYOUTS-ITEM.RETURNED': 'payout.reversed',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED': 'payout.reversed',
  'PAYMENT.PAYOUTS-ITEM.REVERSED': 'payout.reversed',
  'PAYMENT.PAYOUTSBATCH.DENIED': 'payout.failed',
};

/** A payout item's status; UNCLAIMED waits for the recipient to open a PayPal account (30 days, then RETURNED). */
function mapPayoutStatus(status: string | undefined): ProviderPayoutStatus {
  switch (status) {
    case 'SUCCESS':
      return 'successful';
    case 'FAILED':
    case 'DENIED':
    case 'BLOCKED':
    case 'CANCELED':
      return 'failed';
    case 'RETURNED':
    case 'REFUNDED':
    case 'REVERSED':
      return 'reversed';
    default:
      return 'pending';
  }
}

function mapRefundStatus(status: string): ProviderPaymentStatus {
  if (status === 'COMPLETED') return 'successful';
  if (status === 'FAILED' || status === 'CANCELLED') return 'failed';
  return 'pending';
}

/**
 * PayPal adapter using Orders v2 (https://developer.paypal.com/docs/api/orders/v2/).
 *
 * The provider reference is the order id. A PayPal order must be captured after the buyer approves it;
 * verifyPayment() does that, so settlement captures exactly once (PayPal-Request-Id makes it idempotent).
 */
@Injectable()
export class PayPalProvider implements PaymentProvider {
  readonly name = 'paypal';
  readonly supportedCurrencies = ['USD', 'EUR', 'GBP', 'JPY'] as const;

  /**
   * Payouts to PayPal accounts by email (Payouts API). Our payout reference is both the batch's sender_batch_id,
   * which PayPal refuses to reuse for 30 days, and its PayPal-Request-Id, so a resent payout can't pay twice.
   */
  readonly payouts: PayoutCapability = {
    currencies: ['USD', 'EUR', 'GBP', 'JPY'],
    createRecipient: () =>
      Promise.reject(
        new PaymentProviderError(
          'PayPal pays out to PayPal accounts (an email address), not bank accounts',
          false,
        ),
      ),
    createEmailRecipient: (input) => this.createEmailRecipient(input),
    initiate: (input) => this.initiatePayout(input),
    find: (reference, providerReference) =>
      this.findPayout(reference, providerReference),
  };

  private token: { value: string; expiresAt: number } | null = null;
  private readonly certs = new Map<string, Promise<X509Certificate>>();

  constructor(
    @Inject(paymentsConfig.KEY) private readonly config: PaymentsConfig,
    private readonly http: JsonHttpClient,
  ) {}

  async initializePayment(
    input: InitializePaymentInput,
  ): Promise<InitializePaymentResult> {
    const order = await this.call<Order>('POST', '/v2/checkout/orders', {
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: input.reference,
            custom_id: input.reference,
            invoice_id: input.reference,
            amount: this.money(input.amount, input.currency),
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: input.callbackUrl ?? this.config.paypal.returnUrl,
              cancel_url: this.config.paypal.cancelUrl,
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
            },
          },
        },
      },
      requestId: `finstack-init-${input.reference}`,
    });

    const approve = order.links?.find(
      (link) => link.rel === 'payer-action' || link.rel === 'approve',
    );
    if (!approve) {
      throw new PaymentProviderError(
        'PayPal returned an order without an approval link',
        false,
      );
    }
    return { providerReference: order.id, authorizationUrl: approve.href };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    let order = await this.getOrder(input.providerReference);
    if (order.purchase_units?.[0]?.reference_id !== input.reference) {
      throw new PaymentProviderError(
        'PayPal order belongs to another payment',
        false,
      );
    }
    if (order.status === 'APPROVED') {
      order = await this.capture(order.id, input.reference);
    }

    const unit = order.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    if (order.status === 'VOIDED') {
      return this.result(
        order,
        'failed',
        unit?.amount,
        'PayPal order was voided',
      );
    }
    if (order.status !== 'COMPLETED' || !capture) {
      return this.result(order, 'pending', unit?.amount);
    }
    switch (capture.status) {
      case 'COMPLETED':
      case 'PARTIALLY_REFUNDED':
      case 'REFUNDED':
        return this.result(order, 'successful', capture.amount);
      case 'DECLINED':
      case 'FAILED':
        return this.result(
          order,
          'failed',
          capture.amount,
          `PayPal capture ${capture.status.toLowerCase()}`,
        );
      default:
        return this.result(order, 'pending', capture.amount);
    }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const capture = (await this.getOrder(input.providerReference))
      .purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture) {
      throw new PaymentProviderError(
        'PayPal order has no capture to refund',
        false,
      );
    }
    const refund = await this.call<{ id: string; status: string }>(
      'POST',
      `/v2/payments/captures/${encodeURIComponent(capture.id)}/refund`,
      {
        body: {
          amount: this.money(input.amount, input.currency),
          custom_id: input.reference,
        },
        requestId: `finstack-refund-${input.reference}`,
      },
    );
    return {
      providerRefundReference: refund.id,
      status: mapRefundStatus(refund.status),
    };
  }

  /** Our refund is the one whose custom_id is our refund reference (set on creation). */
  async findRefund(
    input: FindRefundInput,
  ): Promise<RefundPaymentResult | null> {
    const refunds =
      (await this.getOrder(input.providerReference)).purchase_units?.[0]
        ?.payments?.refunds ?? [];
    if (refunds.length > FIND_REFUND_MAX) {
      throw new PaymentProviderError(
        'PayPal: too many refunds on this payment to check',
        true,
      );
    }
    for (const summary of refunds) {
      const refund =
        summary.custom_id === undefined
          ? await this.getRefundDetail(summary.id)
          : summary;
      if (refund.custom_id === input.reference) {
        return {
          providerRefundReference: refund.id,
          status: mapRefundStatus(refund.status),
        };
      }
    }
    return null;
  }

  async getRefund(
    providerRefundReference: string,
  ): Promise<RefundPaymentResult> {
    const refund = await this.getRefundDetail(providerRefundReference);
    return {
      providerRefundReference: refund.id,
      status: mapRefundStatus(refund.status),
    };
  }

  /**
   * PayPal signs `<transmission id>|<transmission time>|<webhook id>|<crc32 of raw body>` with RSA-SHA256, using
   * the certificate at PAYPAL-CERT-URL. The certificate must come from PayPal over https, and the webhook id
   * must be ours, so an event sent to another app (or forged) fails.
   */
  async verifyWebhookSignature(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): Promise<boolean> {
    const header = (name: string): string | undefined => {
      const value = headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const transmissionId = header('paypal-transmission-id');
    const transmissionTime = header('paypal-transmission-time');
    const signature = header('paypal-transmission-sig');
    const certUrl = header('paypal-cert-url');
    const algorithm = header('paypal-auth-algo');
    if (
      !transmissionId ||
      !transmissionTime ||
      !signature ||
      !certUrl ||
      algorithm !== 'SHA256withRSA'
    ) {
      return false;
    }

    const sentAt = Date.parse(transmissionTime);
    if (
      Number.isNaN(sentAt) ||
      Math.abs(Date.now() - sentAt) >
        this.config.paypal.webhookToleranceSeconds * 1000
    ) {
      return false;
    }

    let cert: X509Certificate;
    try {
      cert = await this.certificate(certUrl);
    } catch {
      return false;
    }
    const message = `${transmissionId}|${transmissionTime}|${this.config.paypal.webhookId}|${crc32(rawBody)}`;
    return createVerify('RSA-SHA256')
      .update(message)
      .verify(cert.publicKey, signature, 'base64');
  }

  parseWebhookEvent(rawBody: Buffer): ProviderWebhookEvent {
    const event = JSON.parse(rawBody.toString('utf8')) as PayPalEvent;
    const providerType = String(event.event_type);
    const type = EVENT_TYPES[providerType] ?? 'unknown';
    const resource = event.resource;

    if (type.startsWith('payout.')) {
      return {
        eventId: String(event.id),
        type,
        providerType,
        providerReference:
          resource?.payout_item?.sender_item_id ??
          resource?.batch_header?.sender_batch_header?.sender_batch_id,
      };
    }
    if (type === 'refund.succeeded') {
      return {
        eventId: String(event.id),
        type,
        providerType,
        providerReference: resource?.custom_id,
        reference: resource?.custom_id,
      };
    }
    if (type === 'payment.approved') {
      return {
        eventId: String(event.id),
        type,
        providerType,
        providerReference: resource?.id,
        reference: resource?.purchase_units?.[0]?.reference_id,
      };
    }
    return {
      eventId: String(event.id),
      type,
      providerType,
      providerReference:
        type === 'unknown'
          ? undefined
          : resource?.supplementary_data?.related_ids?.order_id,
      reference: resource?.custom_id,
    };
  }

  private createEmailRecipient(
    input: CreateEmailRecipientInput,
  ): Promise<PayoutRecipient> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL.test(email)) {
      return Promise.reject(
        new PaymentProviderError(
          'Not a valid email address for a PayPal payout',
          false,
        ),
      );
    }
    if (!(this.payouts.currencies as string[]).includes(input.currency)) {
      return Promise.reject(
        new PaymentProviderError(
          `PayPal cannot pay out in ${input.currency}`,
          false,
        ),
      );
    }
    // PayPal has no saved-recipient object: the email is the recipient.
    return Promise.resolve({
      recipientReference: email,
      accountName: input.name?.trim() || email,
      bankName: 'PayPal',
    });
  }

  private async initiatePayout(input: {
    reference: string;
    amount: bigint;
    currency: string;
    recipientReference: string;
    narration?: string;
  }): Promise<PayoutResult> {
    const batch = await this.call<PayoutBatch>('POST', '/v1/payments/payouts', {
      body: {
        sender_batch_header: {
          sender_batch_id: input.reference,
          email_subject: 'You have a payment',
          ...(input.narration ? { email_message: input.narration } : {}),
        },
        items: [
          {
            recipient_type: 'EMAIL',
            receiver: input.recipientReference,
            amount: {
              currency: input.currency,
              value: toMajorUnitString(input.amount, input.currency),
            },
            sender_item_id: input.reference,
            ...(input.narration ? { note: input.narration } : {}),
          },
        ],
      },
      requestId: `finstack-payout-${input.reference}`,
    });
    return this.payoutResult(batch);
  }

  /**
   * With the batch id, PayPal's authoritative state. Without it (the response to the send was lost), null: sending
   * again is safe, because PayPal replays the original batch for the same PayPal-Request-Id and refuses a reused
   * sender_batch_id.
   */
  private async findPayout(
    reference: string,
    batchId?: string | null,
  ): Promise<PayoutResult | null> {
    if (!batchId) return null;
    const batch = await this.call<PayoutBatch>(
      'GET',
      `/v1/payments/payouts/${encodeURIComponent(batchId)}`,
    );
    if (batch.batch_header.sender_batch_header?.sender_batch_id !== reference) {
      throw new PaymentProviderError(
        'PayPal payout batch belongs to another payout',
        false,
      );
    }
    return this.payoutResult(batch);
  }

  private payoutResult(batch: PayoutBatch): PayoutResult {
    const item = batch.items?.[0];
    const status =
      batch.batch_header.batch_status === 'DENIED'
        ? 'failed'
        : mapPayoutStatus(item?.transaction_status);
    const reason = item?.errors?.message ?? item?.errors?.name;
    return {
      providerReference: batch.batch_header.payout_batch_id,
      status,
      ...(status === 'failed'
        ? {
            failureReason:
              reason ??
              `PayPal payout ${String(item?.transaction_status ?? batch.batch_header.batch_status).toLowerCase()}`,
          }
        : {}),
    };
  }

  private async capture(orderId: string, reference: string): Promise<Order> {
    try {
      return await this.call<Order>(
        'POST',
        `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
        {
          body: {},
          requestId: `finstack-capture-${reference}`,
        },
      );
    } catch (error) {
      // 422: already captured by another worker, or the buyer's funding was declined (they can retry with
      // another source). Either way the order itself now has the truth.
      if (error instanceof PaymentProviderError && error.httpStatus === 422) {
        return this.getOrder(orderId);
      }
      throw error;
    }
  }

  private result(
    order: Order,
    status: ProviderPaymentStatus,
    amount: Money | undefined,
    failureReason?: string,
  ): VerifyPaymentResult {
    const currency = amount?.currency_code ?? '';
    return {
      status,
      providerReference: order.id,
      amount: amount ? fromMajorUnits(amount.value, currency) : 0n,
      currency,
      ...(failureReason ? { failureReason } : {}),
    };
  }

  private money(amount: bigint, currency: string): Money {
    return {
      currency_code: currency,
      value: toMajorUnitString(amount, currency),
    };
  }

  private getOrder(orderId: string): Promise<Order> {
    return this.call<Order>(
      'GET',
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    );
  }

  private getRefundDetail(refundId: string): Promise<RefundSummary> {
    return this.call<RefundSummary>(
      'GET',
      `/v2/payments/refunds/${encodeURIComponent(refundId)}`,
    );
  }

  private certificate(url: string): Promise<X509Certificate> {
    let cached = this.certs.get(url);
    if (!cached) {
      cached = this.fetchCertificate(url);
      cached.catch(() => this.certs.delete(url));
      this.certs.set(url, cached);
    }
    return cached;
  }

  private async fetchCertificate(url: string): Promise<X509Certificate> {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      !(
        parsed.hostname === 'paypal.com' ||
        parsed.hostname.endsWith('.paypal.com')
      )
    ) {
      throw new Error(`untrusted certificate URL ${url}`);
    }
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.config.paypal.timeoutMs),
    });
    if (!response.ok)
      throw new Error(`certificate download failed: HTTP ${response.status}`);
    const cert = new X509Certificate(await response.text());
    const now = Date.now();
    if (
      now < Date.parse(cert.validFrom) ||
      now > Date.parse(cert.validTo) ||
      !cert.subject.includes('PayPal')
    ) {
      throw new Error('PayPal certificate is expired or not issued to PayPal');
    }
    return cert;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now())
      return this.token.value;
    const credentials = Buffer.from(
      `${this.config.paypal.clientId}:${this.config.paypal.clientSecret}`,
    ).toString('base64');
    const response = await this.http.request<{
      access_token: string;
      expires_in: number;
    }>({
      method: 'POST',
      url: `${this.config.paypal.baseUrl}/v1/oauth2/token`,
      headers: { Authorization: `Basic ${credentials}` },
      form: { grant_type: 'client_credentials' },
      timeoutMs: this.config.paypal.timeoutMs,
    });
    // Renew a minute early so a token never expires mid-request.
    this.token = {
      value: response.body.access_token,
      expiresAt: Date.now() + Math.max(0, response.body.expires_in - 60) * 1000,
    };
    return this.token.value;
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: object; requestId?: string } = {},
  ): Promise<T> {
    const response = await this.http.request<T>({
      method,
      url: `${this.config.paypal.baseUrl}${path}`,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        Prefer: 'return=representation',
        ...(options.requestId
          ? { 'PayPal-Request-Id': options.requestId }
          : {}),
      },
      body: options.body,
      timeoutMs: this.config.paypal.timeoutMs,
    });
    return response.body;
  }
}
