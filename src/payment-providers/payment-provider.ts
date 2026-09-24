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
  'payment.succeeded' | 'payment.failed' | 'unknown';

/** A provider webhook normalised into FinStack's vocabulary. */
export interface ProviderWebhookEvent {
  /** The provider's unique event id, used for duplicate detection. */
  eventId: string;
  type: ProviderEventType;
  /** The provider's type string, kept for audit. */
  providerType: string;
  providerReference?: string;
  reference?: string;
}

/**
 * Contract every payment provider adapter implements. The payment system
 * only talks to this interface, so adding a provider means adding an
 * adapter, not changing payment logic.
 */
export interface PaymentProvider {
  readonly name: string;

  initializePayment(
    input: InitializePaymentInput,
  ): Promise<InitializePaymentResult>;

  /** Asks the provider for the authoritative state of a payment. */
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;

  refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult>;

  /** Checks the webhook signature against the exact raw request body. */
  verifyWebhookSignature(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): boolean;

  /** Parses an already-verified webhook body. */
  parseWebhookEvent(rawBody: Buffer): ProviderWebhookEvent;
}

/** Raised by adapters. `retryable` distinguishes outages from rejections. */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}
