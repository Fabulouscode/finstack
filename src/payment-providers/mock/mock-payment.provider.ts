import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';
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
  event: 'charge.success' | 'charge.failed';
  data: {
    reference: string;
    provider_reference: string;
    amount: string;
    currency: string;
  };
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
  private readonly payments = new Map<string, MockPayment>();

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
    return Promise.resolve({
      providerRefundReference: `mock_refund_${randomBytes(6).toString('hex')}_${input.reference}`,
      status: 'successful',
    });
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
    const type =
      body.event === 'charge.success'
        ? 'payment.succeeded'
        : body.event === 'charge.failed'
          ? 'payment.failed'
          : 'unknown';

    return {
      eventId: String(body.id),
      type,
      providerType: String(body.event),
      providerReference: body.data?.provider_reference,
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

  sign(rawBody: Buffer): string {
    return createHmac('sha256', this.config.mock.webhookSecret)
      .update(rawBody)
      .digest('hex');
  }
}
