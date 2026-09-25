import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';
import { SUPPORTED_CURRENCIES } from '../../common/money/currency';
import { paymentsConfig } from '../../config/payments.config';
import type { PaymentsConfig } from '../../config/payments.config';
import {
  CreatePayoutRecipientInput,
  InitializePaymentInput,
  InitializePaymentResult,
  PaymentProvider,
  PaymentProviderError,
  PayoutCapability,
  PayoutRecipient,
  PayoutResult,
  InitiatePayoutInput,
  ProviderPaymentStatus,
  ProviderPayoutStatus,
  ProviderWebhookEvent,
  ReconciliationCapability,
  TimeRange,
  RefundPaymentInput,
  RefundPaymentResult,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from '../payment-provider';

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

function inRange(date: Date, range: TimeRange): boolean {
  return date >= range.from && date < range.to;
}

interface MockPayment {
  reference: string;
  providerReference: string;
  amount: bigint;
  currency: string;
  status: ProviderPaymentStatus;
  createdAt: Date;
}

export interface MockWebhookBody {
  id: string;
  event:
    | 'charge.success'
    | 'charge.failed'
    | 'refund.processed'
    | 'refund.failed'
    | 'transfer.success'
    | 'transfer.failed'
    | 'transfer.reversed';
  data: {
    reference: string;
    provider_reference?: string;
    amount?: string;
    currency?: string;
  };
}

/** How the next mock refund behaves (tests and local development). */
export type MockRefundBehaviour =
  'successful' | 'pending' | 'rejected' | 'unavailable';

/**
 * How the next mock payouts behave. `lost`: the provider accepts the payout
 * but the response never arrives (a timeout), to exercise safe retries.
 */
export type MockPayoutBehaviour =
  'successful' | 'pending' | 'rejected' | 'unavailable' | 'lost';

/** Bank account number the mock treats as nonexistent. */
export const MOCK_INVALID_ACCOUNT_NUMBER = '0000000000';

interface MockPayout {
  reference: string;
  providerReference: string;
  amount: bigint;
  currency: string;
  status: ProviderPayoutStatus;
  createdAt: Date;
}

interface MockRefund {
  providerRefundReference: string;
  reference: string;
  status: ProviderPaymentStatus;
}

/**
 * An in-memory payment provider for development and tests. It behaves like
 * a real one: idempotent initialisation by reference, authoritative
 * verification, and HMAC-SHA256-signed webhooks. State lives in memory, so
 * it's per process; that's why it is refused in production.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly supportedCurrencies = SUPPORTED_CURRENCIES;
  private readonly payments = new Map<string, MockPayment>();
  private readonly refunds = new Map<string, MockRefund>();
  private refundBehaviour: MockRefundBehaviour = 'successful';
  private readonly payoutsByReference = new Map<string, MockPayout>();
  private payoutBehaviour: MockPayoutBehaviour = 'successful';
  /** Every payout the mock was asked to send, for asserting "sent once". */
  readonly initiatedPayouts: string[] = [];

  readonly payouts: PayoutCapability = {
    currencies: SUPPORTED_CURRENCIES,
    createRecipient: (input) => this.createRecipient(input),
    initiate: (input) => this.initiatePayout(input),
    find: (reference) =>
      Promise.resolve(
        this.payoutResult(this.payoutsByReference.get(reference)),
      ),
  };

  constructor(
    @Inject(paymentsConfig.KEY)
    private readonly config: PaymentsConfig,
  ) {}

  initializePayment(
    input: InitializePaymentInput,
  ): Promise<InitializePaymentResult> {
    const existing = [...this.payments.values()].find(
      (p) => p.reference === input.reference,
    );
    const payment =
      existing ??
      ({
        reference: input.reference,
        providerReference: `mock_${randomBytes(8).toString('hex')}`,
        amount: input.amount,
        currency: input.currency,
        status: 'pending',
        createdAt: new Date(),
      } satisfies MockPayment);
    this.payments.set(payment.providerReference, payment);

    return Promise.resolve({
      providerReference: payment.providerReference,
      authorizationUrl: `https://checkout.mock-provider.test/pay/${payment.providerReference}`,
    });
  }

  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const payment = this.payments.get(input.providerReference);
    if (!payment || payment.reference !== input.reference) {
      return Promise.reject(
        new PaymentProviderError('Unknown mock payment', false),
      );
    }
    return Promise.resolve({
      status: payment.status,
      providerReference: payment.providerReference,
      amount: payment.amount,
      currency: payment.currency,
      ...(payment.status === 'failed'
        ? { failureReason: 'Card declined (mock)' }
        : {}),
    });
  }

  refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    if (this.refundBehaviour === 'rejected') {
      return Promise.reject(
        new PaymentProviderError('Refund declined (mock)', false),
      );
    }
    if (this.refundBehaviour === 'unavailable') {
      return Promise.reject(
        new PaymentProviderError('Mock provider timed out', true),
      );
    }
    // Idempotent by our refund reference, like real providers.
    const existing = [...this.refunds.values()].find(
      (r) => r.reference === input.reference,
    );
    const refund = existing ?? {
      providerRefundReference: `mock_refund_${randomBytes(6).toString('hex')}`,
      reference: input.reference,
      status:
        this.refundBehaviour === 'pending'
          ? ('pending' as const)
          : ('successful' as const),
    };
    this.refunds.set(refund.providerRefundReference, refund);
    return Promise.resolve({
      providerRefundReference: refund.providerRefundReference,
      status: refund.status,
    });
  }

  getRefund(providerRefundReference: string): Promise<RefundPaymentResult> {
    const refund = this.refunds.get(providerRefundReference);
    if (!refund) {
      return Promise.reject(
        new PaymentProviderError('Unknown mock refund', false),
      );
    }
    return Promise.resolve({ providerRefundReference, status: refund.status });
  }

  verifyWebhookSignature(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): boolean {
    const received = headers[MOCK_SIGNATURE_HEADER];
    if (typeof received !== 'string' || !/^[0-9a-f]{64}$/.test(received)) {
      return false;
    }
    const expected = this.sign(rawBody);
    return timingSafeEqual(
      Buffer.from(received, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  }

  parseWebhookEvent(rawBody: Buffer): ProviderWebhookEvent {
    const body = JSON.parse(
      rawBody.toString('utf8'),
    ) as Partial<MockWebhookBody>;
    const types: Record<string, ProviderWebhookEvent['type']> = {
      'charge.success': 'payment.succeeded',
      'charge.failed': 'payment.failed',
      'refund.processed': 'refund.succeeded',
      'refund.failed': 'refund.failed',
      'transfer.success': 'payout.succeeded',
      'transfer.failed': 'payout.failed',
      'transfer.reversed': 'payout.reversed',
    };
    const type = types[String(body.event)] ?? 'unknown';
    // Refund and payout webhooks echo our own reference.
    const isRefund = type.startsWith('refund.') || type.startsWith('payout.');

    return {
      eventId: String(body.id),
      type,
      providerType: String(body.event),
      // Refund webhooks echo our refund reference.
      providerReference: isRefund
        ? body.data?.reference
        : body.data?.provider_reference,
      reference: body.data?.reference,
    };
  }

  // ---- Simulation helpers (dev/test only) -------------------------------------

  /** Settles a mock payment as the customer paying (or failing to pay) would. */
  simulateOutcome(
    providerReference: string,
    outcome: 'successful' | 'failed',
    overrides: { amount?: bigint; currency?: string } = {},
  ): { rawBody: Buffer; signature: string } {
    const payment = this.payments.get(providerReference);
    if (!payment) {
      throw new PaymentProviderError('Unknown mock payment', false);
    }
    payment.status = outcome;
    if (overrides.amount !== undefined) payment.amount = overrides.amount;
    if (overrides.currency !== undefined) payment.currency = overrides.currency;

    const body: MockWebhookBody = {
      id: `evt_${randomBytes(8).toString('hex')}`,
      event: outcome === 'successful' ? 'charge.success' : 'charge.failed',
      data: {
        reference: payment.reference,
        provider_reference: payment.providerReference,
        amount: payment.amount.toString(),
        currency: payment.currency,
      },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    return { rawBody, signature: this.sign(rawBody) };
  }

  /** Makes the next refunds succeed, stay pending, be rejected or time out. */
  setRefundBehaviour(behaviour: MockRefundBehaviour): void {
    this.refundBehaviour = behaviour;
  }

  /** Settles a pending mock refund and returns the signed webhook. */
  simulateRefundOutcome(
    providerRefundReference: string,
    outcome: 'successful' | 'failed',
  ): { rawBody: Buffer; signature: string } {
    const refund = this.refunds.get(providerRefundReference);
    if (!refund) {
      throw new PaymentProviderError('Unknown mock refund', false);
    }
    refund.status = outcome;
    const body: MockWebhookBody = {
      id: `evt_${randomBytes(8).toString('hex')}`,
      event: outcome === 'successful' ? 'refund.processed' : 'refund.failed',
      data: { reference: refund.reference },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    return { rawBody, signature: this.sign(rawBody) };
  }

  readonly reconciliation: ReconciliationCapability = {
    listPayments: (range) =>
      Promise.resolve(
        [...this.payments.values()]
          .filter((p) => inRange(p.createdAt, range))
          .map((p) => ({
            providerReference: p.providerReference,
            reference: p.reference,
            status: p.status,
            amount: p.amount,
            currency: p.currency,
            createdAt: p.createdAt,
          })),
      ),
    listPayouts: (range) =>
      Promise.resolve(
        [...this.payoutsByReference.values()]
          .filter((p) => inRange(p.createdAt, range))
          .map((p) => ({
            reference: p.reference,
            providerReference: p.providerReference,
            status: p.status,
            amount: p.amount,
            currency: p.currency,
            createdAt: p.createdAt,
          })),
      ),
  };

  /**
   * A payment that exists only at the provider (e.g. a lost initialisation
   * response, or a charge made outside FinStack), for reconciliation tests.
   */
  recordExternalPayment(input: {
    amount: bigint;
    currency: string;
    status?: ProviderPaymentStatus;
  }): string {
    const providerReference = `mock_${randomBytes(8).toString('hex')}`;
    this.payments.set(providerReference, {
      reference: `ext_${randomBytes(6).toString('hex')}`,
      providerReference,
      amount: input.amount,
      currency: input.currency,
      status: input.status ?? 'successful',
      createdAt: new Date(),
    });
    return providerReference;
  }

  /** Changes what the provider reports for a payment, without a webhook. */
  setPaymentStatus(
    providerReference: string,
    status: ProviderPaymentStatus,
  ): void {
    const payment = this.payments.get(providerReference);
    if (!payment) {
      throw new PaymentProviderError('Unknown mock payment', false);
    }
    payment.status = status;
  }

  /** Makes the next payouts succeed, stay pending, fail or time out. */
  setPayoutBehaviour(behaviour: MockPayoutBehaviour): void {
    this.payoutBehaviour = behaviour;
  }

  /** Settles (or reverses) a mock payout and returns the signed webhook. */
  simulatePayoutOutcome(
    reference: string,
    outcome: 'successful' | 'failed' | 'reversed',
  ): { rawBody: Buffer; signature: string } {
    const payout = this.payoutsByReference.get(reference);
    if (!payout) {
      throw new PaymentProviderError('Unknown mock payout', false);
    }
    payout.status = outcome;
    const events = {
      successful: 'transfer.success',
      failed: 'transfer.failed',
      reversed: 'transfer.reversed',
    } as const;
    const body: MockWebhookBody = {
      id: `evt_${randomBytes(8).toString('hex')}`,
      event: events[outcome],
      data: { reference, provider_reference: payout.providerReference },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    return { rawBody, signature: this.sign(rawBody) };
  }

  private createRecipient(
    input: CreatePayoutRecipientInput,
  ): Promise<PayoutRecipient> {
    if (input.accountNumber === MOCK_INVALID_ACCOUNT_NUMBER) {
      return Promise.reject(
        new PaymentProviderError('Could not resolve account (mock)', false),
      );
    }
    // Deterministic, like providers that return the existing recipient.
    const id = createHmac('sha256', 'mock-recipient')
      .update(`${input.currency}:${input.bankCode}:${input.accountNumber}`)
      .digest('hex')
      .slice(0, 16);
    return Promise.resolve({
      recipientReference: `RCP_mock_${id}`,
      accountName: input.accountName ?? 'Mock Account Holder',
      bankName: `Mock Bank ${input.bankCode}`,
    });
  }

  private initiatePayout(input: InitiatePayoutInput): Promise<PayoutResult> {
    if (this.payoutBehaviour === 'rejected') {
      return Promise.reject(
        new PaymentProviderError('Insufficient provider balance (mock)', false),
      );
    }
    if (this.payoutBehaviour === 'unavailable') {
      return Promise.reject(
        new PaymentProviderError('Mock provider timed out', true),
      );
    }
    const existing = this.payoutsByReference.get(input.reference);
    if (existing) {
      // Real providers refuse a reused reference.
      return Promise.reject(
        new PaymentProviderError('Duplicate transfer reference (mock)', false),
      );
    }
    const payout: MockPayout = {
      reference: input.reference,
      providerReference: `TRF_mock_${randomBytes(6).toString('hex')}`,
      amount: input.amount,
      currency: input.currency,
      createdAt: new Date(),
      status: this.payoutBehaviour === 'pending' ? 'pending' : 'successful',
    };
    this.payoutsByReference.set(input.reference, payout);
    this.initiatedPayouts.push(input.reference);

    if (this.payoutBehaviour === 'lost') {
      payout.status = 'successful';
      return Promise.reject(
        new PaymentProviderError('Mock provider timed out', true),
      );
    }
    return Promise.resolve(this.payoutResult(payout) as PayoutResult);
  }

  private payoutResult(payout: MockPayout | undefined): PayoutResult | null {
    if (!payout) return null;
    return {
      providerReference: payout.providerReference,
      status: payout.status,
      ...(payout.status === 'failed'
        ? { failureReason: 'Transfer failed (mock)' }
        : {}),
    };
  }

  sign(rawBody: Buffer): string {
    return createHmac('sha256', this.config.mock.webhookSecret)
      .update(rawBody)
      .digest('hex');
  }
}
