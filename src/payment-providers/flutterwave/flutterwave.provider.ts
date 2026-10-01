import { Inject, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';
import { isSupportedCurrency } from '../../common/money/currency';
import {
  fromMajorUnits,
  toMajorUnitNumber,
} from '../../common/money/major-units';
import { paymentsConfig } from '../../config/payments.config';
import type { PaymentsConfig } from '../../config/payments.config';
import { JsonHttpClient } from '../http/json-http-client';
import {
  CreatePayoutRecipientInput,
  FindRefundInput,
  InitializePaymentInput,
  InitializePaymentResult,
  InitiatePayoutInput,
  PaymentProvider,
  PaymentProviderError,
  PayoutCapability,
  PayoutRecipient,
  PayoutResult,
  ProviderPaymentRecord,
  ProviderPaymentStatus,
  ProviderPayoutRecord,
  ProviderPayoutStatus,
  ProviderWebhookEvent,
  ReconciliationCapability,
  RefundPaymentInput,
  RefundPaymentResult,
  TimeRange,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from '../payment-provider';
import { pickOurRefund } from '../refund-lookup';

export const FLUTTERWAVE_SIGNATURE_HEADER = 'verif-hash';

/** Flutterwave's response envelope: `{ status, message, data, meta }`. */
interface FlutterwaveEnvelope<T> {
  status: string;
  message: string;
  data: T;
  meta?: { page_info?: { current_page?: number; total_pages?: number } };
}

interface FlutterwaveTransaction {
  id: number;
  tx_ref: string;
  status: string;
  amount: number | string;
  currency: string;
  processor_response?: string;
  created_at?: string;
}

interface FlutterwaveTransfer {
  id: number;
  reference: string;
  status: string;
  amount: number | string;
  currency: string;
  complete_message?: string;
  created_at?: string;
}

interface FlutterwaveBeneficiary {
  id: number;
  account_number: string;
  bank_code: string;
  full_name: string;
  bank_name?: string | null;
}

interface FlutterwaveListedRefund {
  id: number;
  status: string;
  comment?: string | null;
  comments?: string | null;
  transaction_id?: number | string;
  tx_id?: number | string;
}

interface FlutterwaveRefund {
  id: number;
  status: string;
}

/**
 * Both webhook formats Flutterwave sends: v3 (`event` plus `data`) and the
 * older format accounts get unless "v3 webhooks" is enabled in the
 * dashboard (top-level fields, `txRef`, `"event.type": "CARD_TRANSACTION"`).
 */
interface FlutterwaveWebhookBody {
  event?: string;
  data?: WebhookRecord;
  // Older format:
  'event.type'?: string;
  id?: number | string;
  txRef?: string;
  status?: string;
  transfer?: WebhookRecord;
}

interface WebhookRecord {
  id?: number | string;
  tx_ref?: string;
  reference?: string;
  status?: string;
}

/** A webhook reduced to what FinStack acts on, whatever its format. */
interface NormalisedWebhook {
  kind: 'charge' | 'transfer';
  id: string;
  status: string;
  /** Our reference: the payment's `tx_ref` or the payout's reference. */
  reference: string | undefined;
  providerType: string;
}

function normaliseWebhook(
  body: FlutterwaveWebhookBody,
): NormalisedWebhook | null {
  const record = (
    kind: 'charge' | 'transfer',
    data: WebhookRecord,
    providerType: string,
  ): NormalisedWebhook => ({
    kind,
    id: String(data.id),
    status: String(data.status ?? ''),
    reference: kind === 'charge' ? data.tx_ref : data.reference,
    providerType,
  });
  if (body.event === 'charge.completed') {
    return record('charge', body.data ?? {}, body.event);
  }
  if (body.event === 'transfer.completed') {
    return record('transfer', body.data ?? {}, body.event);
  }
  const legacyType = body['event.type'] ?? 'legacy';
  if (typeof body.txRef === 'string') {
    return record(
      'charge',
      { id: body.id, tx_ref: body.txRef, status: body.status },
      legacyType,
    );
  }
  if (body.transfer && typeof body.transfer.reference === 'string') {
    return record('transfer', body.transfer, legacyType);
  }
  return null;
}

function isAlreadyAdded(error: unknown): boolean {
  return (
    error instanceof PaymentProviderError &&
    !error.retryable &&
    /already added/i.test(error.message)
  );
}

/** A day with more than this many pages is refused rather than cut short. */
const LIST_MAX_PAGES = 200;
const DAY_MS = 24 * 3600 * 1000;

/** Transaction statuses (lowercase): successful, failed, pending, ... */
function mapTransactionStatus(status: string): ProviderPaymentStatus {
  switch (status.toLowerCase()) {
    case 'successful':
      return 'successful';
    case 'failed':
    case 'cancelled':
      return 'failed';
    default:
      return 'pending';
  }
}

/** Transfer statuses (uppercase): NEW, PENDING, SUCCESSFUL, FAILED. */
function mapTransferStatus(status: string): ProviderPayoutStatus {
  switch (status.toUpperCase()) {
    case 'SUCCESSFUL':
      return 'successful';
    case 'FAILED':
      return 'failed';
    default:
      return 'pending';
  }
}

/**
 * Refund statuses: `completed` (initiated, on its way to the customer) and
 * its channel variants (`completed-mpgs`, ...) mean Flutterwave has accepted
 * and committed the refund; `processing` and `pending-*` are not final.
 */
function mapRefundStatus(status: string): ProviderPaymentStatus {
  const value = status.toLowerCase();
  if (value === 'completed' || value.startsWith('completed-')) {
    return 'successful';
  }
  if (value === 'failed' || value.startsWith('failed-')) return 'failed';
  return 'pending';
}

/** YYYY-MM-DD, the date format Flutterwave's list filters take. */
function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Flutterwave adapter (https://developer.flutterwave.com, API v3).
 *
 * Unlike Paystack and Stripe, Flutterwave takes and returns amounts in MAJOR
 * units (1500.50 NGN). Every amount crosses the boundary through the exact
 * conversions in common/money/major-units, never floating-point maths.
 *
 * FinStack's transaction reference is Flutterwave's `tx_ref`, and is also
 * stored as the provider reference: payments are verified by `tx_ref`.
 */
@Injectable()
export class FlutterwaveProvider implements PaymentProvider {
  readonly name = 'flutterwave';
  readonly supportedCurrencies = [
    'NGN',
    'USD',
    'GHS',
    'KES',
    'ZAR',
    'EUR',
    'GBP',
  ] as const;

  /**
   * Transfers to Nigerian bank accounts, through saved beneficiaries (the
   * equivalent of Paystack's recipients), so only the beneficiary id and the
   * last digits are stored.
   */
  readonly payouts: PayoutCapability = {
    currencies: ['NGN'],
    createRecipient: (input) => this.createBeneficiary(input),
    initiate: (input) => this.initiateTransfer(input),
    find: (reference) => this.findTransfer(reference),
  };

  readonly reconciliation: ReconciliationCapability = {
    listPayments: async (range) =>
      (await this.listAll<FlutterwaveTransaction>('/transactions', range)).map(
        (t): ProviderPaymentRecord => ({
          providerReference: t.tx_ref,
          reference: t.tx_ref,
          status: mapTransactionStatus(t.status),
          amount: fromMajorUnits(t.amount, t.currency),
          currency: t.currency,
          createdAt: new Date(t.created_at ?? 0),
        }),
      ),
    listPayouts: async (range) =>
      (await this.listAll<FlutterwaveTransfer>('/transfers', range)).map(
        (t): ProviderPayoutRecord => ({
          reference: t.reference,
          providerReference: String(t.id),
          status: mapTransferStatus(t.status),
          amount: fromMajorUnits(t.amount, t.currency),
          currency: t.currency,
          createdAt: new Date(t.created_at ?? 0),
        }),
      ),
  };

  constructor(
    @Inject(paymentsConfig.KEY) private readonly config: PaymentsConfig,
    private readonly http: JsonHttpClient,
  ) {}

  /** Flutterwave Standard: a hosted checkout link for our `tx_ref`. */
  async initializePayment(
    input: InitializePaymentInput,
  ): Promise<InitializePaymentResult> {
    const { body } = await this.call<{ link: string }>('POST', '/payments', {
      tx_ref: input.reference,
      amount: toMajorUnitNumber(input.amount, input.currency),
      currency: input.currency,
      redirect_url: input.callbackUrl ?? this.config.flutterwave.redirectUrl,
      customer: { email: input.customerEmail },
    });
    return {
      providerReference: input.reference,
      authorizationUrl: body.data.link,
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const transaction = await this.transactionByReference(
      input.providerReference,
    );
    if (transaction.tx_ref !== input.reference) {
      throw new PaymentProviderError(
        'Flutterwave returned a different transaction',
        false,
      );
    }

    const status = mapTransactionStatus(transaction.status);
    return {
      status,
      providerReference: transaction.tx_ref,
      // `amount` is what the merchant asked for; `charged_amount` can also
      // include fees passed on to the customer.
      amount: fromMajorUnits(transaction.amount, transaction.currency),
      currency: transaction.currency,
      ...(status === 'failed' && transaction.processor_response
        ? { failureReason: transaction.processor_response }
        : {}),
    };
  }

  /**
   * Refunds need Flutterwave's numeric transaction id, so the transaction is
   * looked up by our reference first. Our refund reference is sent as the
   * comment, for people reading the Flutterwave dashboard.
   */
  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const transaction = await this.transactionByReference(
      input.providerReference,
    );
    const { body } = await this.call<FlutterwaveRefund>(
      'POST',
      `/transactions/${transaction.id}/refund`,
      {
        amount: toMajorUnitNumber(input.amount, input.currency),
        comments: input.reference,
      },
    );
    return {
      providerRefundReference: String(body.data.id),
      status: mapRefundStatus(body.data.status),
    };
  }

  /**
   * Our refund among the payment's refunds (our reference is sent as the
   * refund comment). Listed by Flutterwave's transaction id; see
   * pickOurRefund for how an unclear answer is handled.
   */
  async findRefund(
    input: FindRefundInput,
  ): Promise<RefundPaymentResult | null> {
    const transaction = await this.transactionByReference(
      input.providerReference,
    );
    const created = new Date(transaction.created_at ?? Date.now());
    const query = new URLSearchParams({
      id: String(transaction.id),
      from: day(new Date(created.getTime() - DAY_MS)),
      to: day(new Date(Date.now() + DAY_MS)),
    });
    const { body } = await this.call<FlutterwaveListedRefund[]>(
      'GET',
      `/refunds?${query.toString()}`,
    );
    if ((body.meta?.page_info?.total_pages ?? 1) > 1) {
      throw new PaymentProviderError(
        'Flutterwave: too many refunds on this payment to check',
        true,
      );
    }
    // Never trust the filter: keep only this transaction's refunds.
    const refunds = body.data.filter((refund) => {
      const id = refund.transaction_id ?? refund.tx_id;
      return id === undefined || Number(id) === transaction.id;
    });
    const ours = pickOurRefund(
      refunds,
      input.reference,
      (refund) => refund.comment ?? refund.comments,
      'Flutterwave',
    );
    return ours
      ? {
          providerRefundReference: String(ours.id),
          status: mapRefundStatus(ours.status),
        }
      : null;
  }

  async getRefund(
    providerRefundReference: string,
  ): Promise<RefundPaymentResult> {
    const { body } = await this.call<FlutterwaveRefund>(
      'GET',
      `/refunds/${encodeURIComponent(providerRefundReference)}`,
    );
    return {
      providerRefundReference: String(body.data.id),
      status: mapRefundStatus(body.data.status),
    };
  }

  /**
   * Flutterwave sends the dashboard's secret hash verbatim in `verif-hash`
   * (no HMAC). Compared in constant time via fixed-length digests, so
   * neither the value nor its length leaks through timing.
   */
  verifyWebhookSignature(
    _rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): boolean {
    const received = headers[FLUTTERWAVE_SIGNATURE_HEADER];
    const expected = this.config.flutterwave.webhookSecretHash;
    if (typeof received !== 'string' || !expected) return false;
    const digest = (value: string): Buffer =>
      createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(received), digest(expected));
  }

  parseWebhookEvent(rawBody: Buffer): ProviderWebhookEvent {
    const body = JSON.parse(rawBody.toString('utf8')) as FlutterwaveWebhookBody;
    const webhook = normaliseWebhook(body);

    if (webhook) {
      // The same id across formats, so a charge delivered in both formats is
      // processed once; the status is part of it because a record can be
      // reported again when its status changes.
      const event =
        webhook.kind === 'charge' ? 'charge.completed' : 'transfer.completed';
      const failed =
        webhook.kind === 'charge'
          ? mapTransactionStatus(webhook.status) === 'failed'
          : mapTransferStatus(webhook.status) === 'failed';
      return {
        eventId: `${event}:${webhook.id}:${webhook.status}`,
        type:
          webhook.kind === 'charge'
            ? failed
              ? 'payment.failed'
              : 'payment.succeeded'
            : failed
              ? 'payout.failed'
              : 'payout.succeeded',
        providerType: webhook.providerType,
        providerReference: webhook.reference,
        reference: webhook.reference,
      };
    }

    // Everything else, including refund webhooks (which carry no event name
    // and none of our references): stored, then ignored as unhandled.
    // Refunds are confirmed by asking Flutterwave instead.
    const event = body.event ?? body['event.type'] ?? 'unnamed';
    return {
      eventId: `${event}:${createHash('sha256').update(rawBody).digest('hex')}`,
      type: 'unknown',
      providerType: event,
    };
  }

  /**
   * Nigerian accounts are resolved first, so the stored name is the bank's,
   * not whatever was typed in; then saved as a beneficiary.
   */
  private async createBeneficiary(
    input: CreatePayoutRecipientInput,
  ): Promise<PayoutRecipient> {
    if (input.currency !== 'NGN') {
      throw new PaymentProviderError(
        `Flutterwave payouts in ${input.currency} are not supported`,
        false,
      );
    }
    const { body: resolved } = await this.call<{ account_name: string }>(
      'POST',
      '/accounts/resolve',
      { account_number: input.accountNumber, account_bank: input.bankCode },
    );
    let beneficiary: FlutterwaveBeneficiary;
    try {
      ({
        body: { data: beneficiary },
      } = await this.call<FlutterwaveBeneficiary>('POST', '/beneficiaries', {
        account_bank: input.bankCode,
        account_number: input.accountNumber,
        beneficiary_name: resolved.data.account_name,
        currency: input.currency,
      }));
    } catch (error) {
      // Saved before (e.g. removed and added again in FinStack): Flutterwave
      // refuses a second copy, so reuse the one it has.
      const existing = isAlreadyAdded(error)
        ? await this.findBeneficiary(input.bankCode, input.accountNumber)
        : null;
      if (!existing) throw error;
      beneficiary = existing;
    }
    return {
      recipientReference: String(beneficiary.id),
      accountName: beneficiary.full_name || resolved.data.account_name,
      bankName: beneficiary.bank_name ?? null,
    };
  }

  private async findBeneficiary(
    bankCode: string,
    accountNumber: string,
  ): Promise<FlutterwaveBeneficiary | null> {
    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      const { body } = await this.call<FlutterwaveBeneficiary[]>(
        'GET',
        `/beneficiaries?page=${page}`,
      );
      const match = body.data.find(
        (b) => b.bank_code === bankCode && b.account_number === accountNumber,
      );
      if (match) return match;
      const totalPages = body.meta?.page_info?.total_pages ?? 1;
      if (page >= totalPages || body.data.length === 0) break;
    }
    return null;
  }

  /** Our payout reference is the transfer `reference` (unique per transfer). */
  private async initiateTransfer(
    input: InitiatePayoutInput,
  ): Promise<PayoutResult> {
    const { body } = await this.call<FlutterwaveTransfer>(
      'POST',
      '/transfers',
      {
        beneficiary: Number(input.recipientReference),
        amount: toMajorUnitNumber(input.amount, input.currency),
        currency: input.currency,
        debit_currency: input.currency,
        reference: input.reference,
        ...(input.narration ? { narration: input.narration } : {}),
      },
    );
    return this.transferResult(body.data);
  }

  /** The transfer with our reference, or null if Flutterwave never got it. */
  private async findTransfer(reference: string): Promise<PayoutResult | null> {
    const query = new URLSearchParams({ reference });
    const { body } = await this.call<FlutterwaveTransfer[]>(
      'GET',
      `/transfers?${query.toString()}`,
    );
    // Matched exactly: never trust a filter to have been applied.
    const transfer = body.data.find((t) => t.reference === reference);
    return transfer ? this.transferResult(transfer) : null;
  }

  private transferResult(transfer: FlutterwaveTransfer): PayoutResult {
    const status = mapTransferStatus(transfer.status);
    return {
      providerReference: String(transfer.id),
      status,
      ...(status === 'failed' && transfer.complete_message
        ? { failureReason: transfer.complete_message }
        : {}),
    };
  }

  private async transactionByReference(
    txRef: string,
  ): Promise<FlutterwaveTransaction> {
    const query = new URLSearchParams({ tx_ref: txRef });
    const { body } = await this.call<FlutterwaveTransaction>(
      'GET',
      `/transactions/verify_by_reference?${query.toString()}`,
    );
    return body.data;
  }

  /**
   * Every item of a paginated list created within `range`. Flutterwave
   * filters by whole days in its own timezone, so a day either side is
   * fetched and the exact half-open range applied here.
   */
  private async listAll<T extends { created_at?: string; currency: string }>(
    path: string,
    range: TimeRange,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      if (page > LIST_MAX_PAGES) {
        throw new PaymentProviderError(
          `Flutterwave ${path}: more than ${LIST_MAX_PAGES} pages; use a shorter period`,
          false,
        );
      }
      const query = new URLSearchParams({
        from: day(new Date(range.from.getTime() - DAY_MS)),
        to: day(new Date(range.to.getTime() + DAY_MS)),
        page: String(page),
      });
      const { body } = await this.call<T[]>(
        'GET',
        `${path}?${query.toString()}`,
      );
      items.push(...body.data);
      const totalPages = body.meta?.page_info?.total_pages ?? 1;
      if (page >= totalPages || body.data.length === 0) break;
    }
    return items.filter((item) => {
      const created = new Date(item.created_at ?? 0);
      // Currencies FinStack doesn't support can't be FinStack's payments.
      return (
        created >= range.from &&
        created < range.to &&
        isSupportedCurrency(item.currency)
      );
    });
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: object,
  ): Promise<{ body: FlutterwaveEnvelope<T> }> {
    const response = await this.http.request<FlutterwaveEnvelope<T>>({
      method,
      url: `${this.config.flutterwave.baseUrl}${path}`,
      headers: {
        Authorization: `Bearer ${this.config.flutterwave.secretKey}`,
      },
      body,
      timeoutMs: this.config.flutterwave.timeoutMs,
    });
    if (response.body.status !== 'success' || !response.body.data) {
      throw new PaymentProviderError(
        `Flutterwave: ${response.body.message || 'request not successful'}`,
        false,
      );
    }
    return response;
  }
}
