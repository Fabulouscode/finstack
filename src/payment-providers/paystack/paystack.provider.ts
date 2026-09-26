import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';
import { paymentsConfig } from '../../config/payments.config';
import type { PaymentsConfig } from '../../config/payments.config';
import { JsonHttpClient } from '../http/json-http-client';
import {
  CreatePayoutRecipientInput,
  InitializePaymentInput,
  InitiatePayoutInput,
  InitializePaymentResult,
  PaymentProvider,
  PaymentProviderError,
  PayoutCapability,
  PayoutRecipient,
  PayoutResult,
  ProviderPaymentStatus,
  ProviderPayoutStatus,
  ProviderRecordStatus,
  ReconciliationCapability,
  TimeRange,
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
  meta?: { page?: number; pageCount?: number };
}

interface PaystackListedTransaction {
  reference: string;
  status: string;
  amount: number;
  currency: string;
  created_at?: string;
  createdAt?: string;
}

interface PaystackListedTransfer {
  reference: string;
  transfer_code: string;
  status: string;
  amount: number;
  currency: string;
  createdAt?: string;
  created_at?: string;
}

const LIST_PAGE_SIZE = 100;
/** A day with more than this many pages is refused rather than cut short. */
const LIST_MAX_PAGES = 200;

/** Transaction statuses as reconciliation sees them (refunds stay collected). */
function mapListedStatus(status: string): ProviderRecordStatus {
  switch (status) {
    case 'success':
      return 'successful';
    case 'reversed':
      return 'refunded';
    case 'failed':
    case 'abandoned':
      return 'failed';
    default:
      return 'pending';
  }
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
  data?: {
    id?: number | string;
    reference?: string;
    transaction_reference?: string;
    amount?: number | string;
  };
}

interface PaystackTransfer {
  transfer_code: string;
  reference: string;
  status: string;
  reason?: string;
}

/** Paystack recipient type per payout currency (bank accounts). */
const RECIPIENT_TYPES: Readonly<Record<string, string>> = {
  NGN: 'nuban',
  GHS: 'ghipss',
  ZAR: 'basa',
};

function mapTransferStatus(status: string): ProviderPayoutStatus {
  switch (status) {
    case 'success':
      return 'successful';
    case 'failed':
    case 'abandoned':
    case 'rejected':
      return 'failed';
    case 'reversed':
      return 'reversed';
    default:
      // pending, processing, received, queued, otp: not final yet. (Turn off
      // OTP for API transfers in the Paystack dashboard, or payouts will wait
      // for a code no one enters.)
      return 'pending';
  }
}

function mapRefundStatus(status: string): ProviderPaymentStatus {
  if (status === 'processed') return 'successful';
  if (status === 'failed') return 'failed';
  return 'pending';
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
  /**
   * Paystack can also charge USD, but FinStack processes USD through Stripe
   * only (see CURRENCY_PROVIDER_POLICY), so it's not offered here.
   */
  readonly supportedCurrencies = ['NGN', 'GHS', 'ZAR', 'KES'] as const;

  /** Paystack Transfers (https://paystack.com/docs/transfers). */
  readonly payouts: PayoutCapability = {
    currencies: Object.keys(RECIPIENT_TYPES),
    createRecipient: (input) => this.createRecipient(input),
    initiate: (input) => this.initiateTransfer(input),
    find: (reference) => this.findTransfer(reference),
  };

  readonly reconciliation: ReconciliationCapability = {
    listPayments: async (range) =>
      (
        await this.listAll<PaystackListedTransaction>('/transaction', range)
      ).map((t) => ({
        providerReference: t.reference,
        reference: t.reference,
        status: mapListedStatus(t.status),
        amount: BigInt(t.amount),
        currency: t.currency,
        createdAt: new Date(t.created_at ?? t.createdAt ?? 0),
      })),
    listPayouts: async (range) =>
      (await this.listAll<PaystackListedTransfer>('/transfer', range)).map(
        (t) => ({
          reference: t.reference,
          providerReference: t.transfer_code,
          status: mapTransferStatus(t.status),
          amount: BigInt(t.amount),
          currency: t.currency,
          createdAt: new Date(t.createdAt ?? t.created_at ?? 0),
        }),
      ),
  };

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
      status: mapRefundStatus(body.data.status),
    };
  }

  async getRefund(
    providerRefundReference: string,
  ): Promise<RefundPaymentResult> {
    const { body } = await this.call<{ id: number; status: string }>(
      'GET',
      `/refund/${encodeURIComponent(providerRefundReference)}`,
    );
    return {
      providerRefundReference: String(body.data.id),
      status: mapRefundStatus(body.data.status),
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
    const types: Record<string, ProviderWebhookEvent['type']> = {
      'charge.success': 'payment.succeeded',
      'charge.failed': 'payment.failed',
      'refund.processed': 'refund.succeeded',
      'refund.failed': 'refund.failed',
      'transfer.success': 'payout.succeeded',
      'transfer.failed': 'payout.failed',
      'transfer.reversed': 'payout.reversed',
    };
    const type = types[event] ?? 'unknown';

    if (type === 'refund.succeeded' || type === 'refund.failed') {
      // Refund events reference the refunded payment (our payment reference).
      // Several partial refunds can share it, so amount and id are part of
      // the dedupe key; the refunds are re-checked with Paystack anyway.
      const paymentReference =
        body.data?.transaction_reference ?? body.data?.reference;
      return {
        eventId: `${event}:${String(paymentReference)}:${String(body.data?.amount)}:${String(body.data?.id)}`,
        type,
        providerType: event,
        providerReference: paymentReference,
        reference: paymentReference,
      };
    }

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

  /**
   * Nigerian accounts are resolved first, so the stored name is the bank's,
   * not whatever was typed in. Elsewhere the caller supplies the name.
   */
  private async createRecipient(
    input: CreatePayoutRecipientInput,
  ): Promise<PayoutRecipient> {
    const type = RECIPIENT_TYPES[input.currency];
    if (!type) {
      throw new PaymentProviderError(
        `Paystack cannot pay out in ${input.currency}`,
        false,
      );
    }

    let name = input.accountName;
    if (input.currency === 'NGN') {
      const query = new URLSearchParams({
        account_number: input.accountNumber,
        bank_code: input.bankCode,
      });
      const { body } = await this.call<{ account_name: string }>(
        'GET',
        `/bank/resolve?${query.toString()}`,
      );
      name = body.data.account_name;
    }
    if (!name) {
      throw new PaymentProviderError(
        'accountName is required for this currency',
        false,
      );
    }

    const { body } = await this.call<{
      recipient_code: string;
      name: string;
      details?: { bank_name?: string | null };
    }>('POST', '/transferrecipient', {
      type,
      name,
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      currency: input.currency,
    });
    return {
      recipientReference: body.data.recipient_code,
      accountName: body.data.name,
      bankName: body.data.details?.bank_name ?? null,
    };
  }

  /** Our payout reference is Paystack's transfer `reference` (idempotent). */
  private async initiateTransfer(
    input: InitiatePayoutInput,
  ): Promise<PayoutResult> {
    const { body } = await this.call<PaystackTransfer>('POST', '/transfer', {
      source: 'balance',
      amount: input.amount.toString(),
      currency: input.currency,
      recipient: input.recipientReference,
      reference: input.reference,
      ...(input.narration ? { reason: input.narration } : {}),
    });
    return this.transferResult(body.data);
  }

  private async findTransfer(reference: string): Promise<PayoutResult | null> {
    try {
      const { body } = await this.call<PaystackTransfer>(
        'GET',
        `/transfer/verify/${encodeURIComponent(reference)}`,
      );
      return this.transferResult(body.data);
    } catch (error) {
      if (error instanceof PaymentProviderError && error.httpStatus === 404) {
        return null;
      }
      throw error;
    }
  }

  private transferResult(transfer: PaystackTransfer): PayoutResult {
    const status = mapTransferStatus(transfer.status);
    return {
      providerReference: transfer.transfer_code,
      status,
      ...(status === 'failed' && transfer.reason
        ? { failureReason: transfer.reason }
        : {}),
    };
  }

  /** Every item of a paginated list endpoint created within `range`. */
  private async listAll<T extends { createdAt?: string; created_at?: string }>(
    path: string,
    range: TimeRange,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      if (page > LIST_MAX_PAGES) {
        throw new PaymentProviderError(
          `Paystack ${path}: more than ${LIST_MAX_PAGES} pages; use a shorter period`,
          false,
        );
      }
      const query = new URLSearchParams({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        perPage: String(LIST_PAGE_SIZE),
        page: String(page),
      });
      const { body } = await this.call<T[]>(
        'GET',
        `${path}?${query.toString()}`,
      );
      items.push(...body.data);
      const pageCount = body.meta?.pageCount ?? 1;
      if (page >= pageCount || body.data.length === 0) break;
    }
    // Paystack's `to` is inclusive; keep the range half-open.
    return items.filter((item) => {
      const created = new Date(item.created_at ?? item.createdAt ?? 0);
      return created >= range.from && created < range.to;
    });
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
