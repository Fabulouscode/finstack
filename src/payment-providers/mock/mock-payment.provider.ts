import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';
import { SUPPORTED_CURRENCIES } from '../../common/money/currency';
import { paymentsConfig } from '../../config/payments.config';
import type { PaymentsConfig } from '../../config/payments.config';
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

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

interface MockPayment {
  reference: string;
  providerReference: string;
  amount: bigint;
  currency: string;
  status: ProviderPaymentStatus;
}

export interface MockWebhookBody {
  id: string;
  event:
    'charge.success' | 'charge.failed' | 'refund.processed' | 'refund.failed';
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
    };
    const type = types[String(body.event)] ?? 'unknown';
    const isRefund = type === 'refund.succeeded' || type === 'refund.failed';

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

  sign(rawBody: Buffer): string {
    return createHmac('sha256', this.config.mock.webhookSecret)
      .update(rawBody)
      .digest('hex');
  }
}
