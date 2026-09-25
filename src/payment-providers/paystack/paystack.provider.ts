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

export const PAYSTACK_SIGNATURE_HEADER = 'x-paystack-signature';

/** Paystack's response envelope: `{ status, message, data }`. */
interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

interface PaystackTransaction {
  id: number;
  reference: string;
  status: string;
  amount: number;
  currency: string;
  gateway_response?: string;
}

interface PaystackWebhookBody {
  event?: string;
  data?: { id?: number | string; reference?: string };
}

/**
 * Paystack adapter (https://paystack.com/docs/api). Amounts are already in
 * the currency's subunit (kobo, pesewas, cents), like FinStack's.
 *
 * FinStack's transaction reference is passed as Paystack's `reference`, so
 * re-initialising after a timeout is idempotent, and the provider reference
 * equals our reference.
 */
@Injectable()
export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack';
  readonly supportedCurrencies = ['NGN', 'USD', 'GHS', 'ZAR', 'KES'] as const;

  constructor(
    @Inject(paymentsConfig.KEY) private readonly config: PaymentsConfig,
    private readonly http: JsonHttpClient,
  ) {}

  async initializePayment(
    input: InitializePaymentInput,
  ): Promise<InitializePaymentResult> {
    const { body } = await this.call<{
      authorization_url: string;
      reference: string;
    }>('POST', '/transaction/initialize', {
      email: input.customerEmail,
      amount: input.amount.toString(),
      currency: input.currency,
      reference: input.reference,
      ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
    });
    return {
      providerReference: body.data.reference,
      authorizationUrl: body.data.authorization_url,
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const { body } = await this.call<PaystackTransaction>(
      'GET',
      `/transaction/verify/${encodeURIComponent(input.providerReference)}`,
    );
    const transaction = body.data;
    if (transaction.reference !== input.reference) {
      throw new PaymentProviderError(
        'Paystack returned a different transaction',
        false,
      );
    }

    const status = mapStatus(transaction.status);
    return {
      status,
      providerReference: transaction.reference,
      amount: BigInt(transaction.amount),
      currency: transaction.currency,
      ...(status === 'failed' && transaction.gateway_response
        ? { failureReason: transaction.gateway_response }
        : {}),
    };
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const { body } = await this.call<{ id: number; status: string }>(
      'POST',
      '/refund',
      {
        transaction: input.providerReference,
        amount: input.amount.toString(),
        currency: input.currency,
        merchant_note: input.reference,
      },
    );
    return {
      providerRefundReference: String(body.data.id),
      status: body.data.status === 'processed' ? 'successful' : 'pending',
    };
  }

  /** HMAC-SHA512 of the raw body with the secret key, hex-encoded. */
  verifyWebhookSignature(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): boolean {
    const received = headers[PAYSTACK_SIGNATURE_HEADER];
    if (typeof received !== 'string' || !/^[0-9a-f]{128}$/.test(received)) {
      return false;
    }
    const expected = createHmac('sha512', this.config.paystack.secretKey)
      .update(rawBody)
      .digest();
    return timingSafeEqual(Buffer.from(received, 'hex'), expected);
  }

  parseWebhookEvent(rawBody: Buffer): ProviderWebhookEvent {
    const body = JSON.parse(rawBody.toString('utf8')) as PaystackWebhookBody;
    const event = String(body.event);
    const type =
      event === 'charge.success'
        ? 'payment.succeeded'
        : event === 'charge.failed'
          ? 'payment.failed'
          : 'unknown';

    return {
      // Paystack events carry no event id; the event name plus the
      // transaction id identifies a delivery for duplicate detection.
      eventId: `${event}:${String(body.data?.id)}`,
      type,
      providerType: event,
      providerReference: body.data?.reference,
      reference: body.data?.reference,
    };
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: object,
  ): Promise<{ body: PaystackEnvelope<T> }> {
    const response = await this.http.request<PaystackEnvelope<T>>({
      method,
      url: `${this.config.paystack.baseUrl}${path}`,
      headers: { Authorization: `Bearer ${this.config.paystack.secretKey}` },
      body,
      timeoutMs: this.config.paystack.timeoutMs,
    });
    if (!response.body.status || !response.body.data) {
      throw new PaymentProviderError(
        `Paystack: ${response.body.message || 'request not successful'}`,
        false,
      );
    }
    return response;
  }
}

/** Paystack transaction statuses -> FinStack's three outcomes. */
function mapStatus(status: string): ProviderPaymentStatus {
  switch (status) {
    case 'success':
      return 'successful';
    case 'failed':
    case 'abandoned':
    case 'reversed':
      return 'failed';
    default:
      // ongoing, pending, processing, queued: not final yet
      return 'pending';
  }
}
