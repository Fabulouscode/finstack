import { IncomingHttpHeaders } from 'node:http';

export interface InitializePaymentInput {
  /** Our transaction reference; providers must treat it as idempotent. */
  reference: string;
  /** Minor units. */
  amount: bigint;
  currency: string;
  customerEmail: string;
  callbackUrl?: string;
}

export interface InitializePaymentResult {
  providerReference: string;
  /** Where the customer completes the payment (hosted checkout). */
  authorizationUrl: string;
}

export type ProviderPaymentStatus = 'pending' | 'successful' | 'failed';

export interface VerifyPaymentInput {
  reference: string;
  providerReference: string;
}

export interface VerifyPaymentResult {
  status: ProviderPaymentStatus;
  providerReference: string;
  /** What the provider actually collected, in minor units. */
  amount: bigint;
  currency: string;
  failureReason?: string;
}

export interface RefundPaymentInput {
  providerReference: string;
  /** Minor units; partial refunds are allowed. */
  amount: bigint;
  currency: string;
  reference: string;
}

export interface RefundPaymentResult {
  providerRefundReference: string;
  status: ProviderPaymentStatus;
}

export type ProviderEventType =
  | 'payment.succeeded'
  | 'payment.failed'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'payout.succeeded'
  | 'payout.failed'
  | 'payout.reversed'
  | 'unknown';

// ---- Payouts (money out to a bank account) ------------------------------------

export interface CreatePayoutRecipientInput {
  currency: string;
  bankCode: string;
  accountNumber: string;
  /** Needed where the provider can't resolve the account holder's name. */
  accountName?: string;
}

export interface PayoutRecipient {
  /** The provider's id for the saved bank account (e.g. a recipient code). */
  recipientReference: string;
  /** The verified account holder name, where the provider resolves it. */
  accountName: string;
  bankName: string | null;
}

export interface InitiatePayoutInput {
  /** Our payout reference; providers must treat it as idempotent. */
  reference: string;
  /** Minor units. */
  amount: bigint;
  currency: string;
  recipientReference: string;
  narration?: string;
}

/** `reversed`: the provider returned the money after reporting success. */
export type ProviderPayoutStatus =
  'pending' | 'successful' | 'failed' | 'reversed';

export interface PayoutResult {
  providerReference: string;
  status: ProviderPayoutStatus;
  failureReason?: string;
}

/** Optional provider capability: sending money to bank accounts. */
export interface PayoutCapability {
  /** ISO currencies the provider can pay out in. */
  readonly currencies: readonly string[];

  createRecipient(input: CreatePayoutRecipientInput): Promise<PayoutRecipient>;

  initiate(input: InitiatePayoutInput): Promise<PayoutResult>;

  /**
   * The payout with OUR reference, or null if the provider never received
   * it. Checked before (re)sending, so a lost response can't pay twice.
   */
  find(reference: string): Promise<PayoutResult | null>;
}

/** A provider webhook normalised into FinStack's vocabulary. */
export interface ProviderWebhookEvent {
  /** The provider's unique event id, used for duplicate detection. */
  eventId: string;
  type: ProviderEventType;
  /** The provider's type string, kept for audit. */
  providerType: string;
  /**
   * Payment events: the provider's payment reference. Refund events: a
   * FinStack reference the provider echoes back, either the refund's own
   * (`rfd_...`) or the refunded payment's (`trx_...`), depending on the
   * provider. Payout events: our payout reference (`pyt_...`).
   */
  providerReference?: string;
  reference?: string;
}

// ---- Reconciliation (the provider's own records) ------------------------------

/** `refunded`: collected, then (fully) refunded. */
export type ProviderRecordStatus =
  'pending' | 'successful' | 'failed' | 'refunded';

export interface ProviderPaymentRecord {
  /** The provider's reference, as stored on our payment. */
  providerReference: string;
  /** Our transaction reference, when the provider echoes it. */
  reference?: string;
  status: ProviderRecordStatus;
  /** Minor units. */
  amount: bigint;
  currency: string;
  createdAt: Date;
}

export interface ProviderPayoutRecord {
  /** Our payout reference. */
  reference: string;
  providerReference: string;
  status: ProviderPayoutStatus;
  amount: bigint;
  currency: string;
  createdAt: Date;
}

export interface TimeRange {
  from: Date;
  /** Exclusive. */
  to: Date;
}

/** Optional provider capability: listing its records to compare with ours. */
export interface ReconciliationCapability {
  /** Every payment the provider created in the range. */
  listPayments(range: TimeRange): Promise<ProviderPaymentRecord[]>;
  /** Every payout (transfer) in the range, when the provider sends payouts. */
  listPayouts?(range: TimeRange): Promise<ProviderPayoutRecord[]>;
}

/**
 * Contract every payment provider adapter implements. The payment system
 * only talks to this interface, so adding a provider means adding an
 * adapter, not changing payment logic.
 */
export interface PaymentProvider {
  readonly name: string;

  /** ISO currencies the provider can charge in. */
  readonly supportedCurrencies: readonly string[];

  initializePayment(
    input: InitializePaymentInput,
  ): Promise<InitializePaymentResult>;

  /** Asks the provider for the authoritative state of a payment. */
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;

  refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult>;

  /** Authoritative state of a refund created with refundPayment(). */
  getRefund(providerRefundReference: string): Promise<RefundPaymentResult>;

  /** Checks the webhook signature against the exact raw request body. */
  verifyWebhookSignature(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): boolean;

  /** Parses an already-verified webhook body. */
  parseWebhookEvent(rawBody: Buffer): ProviderWebhookEvent;

  /** Present when the provider can send payouts. */
  readonly payouts?: PayoutCapability;

  /** Present when the provider can list its records for reconciliation. */
  readonly reconciliation?: ReconciliationCapability;
}

/** Raised by adapters. `retryable` distinguishes outages from rejections. */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** The provider's HTTP status, when it answered. */
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}
