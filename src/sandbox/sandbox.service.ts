import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CurrencyCode } from '../common/money/currency';
import { toCurrencyCode } from '../common/money/currency';
import { OwnerRef, toOwner } from '../common/owner/owner';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../payment-providers/mock/mock-payment.provider';
import { PaymentProvidersService } from '../payment-providers/payment-providers.service';
import { PaymentSettlementService } from '../payments/payment-settlement.service';
import { PaymentsService, PaymentView } from '../payments/payments.service';
import { PayoutsService, PayoutView } from '../payouts/payouts.service';
import { TransactionStatus } from '../transactions/transaction.types';
import { WalletNotFoundException } from '../wallets/wallets.errors';
import { WalletsService } from '../wallets/wallets.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import {
  NotSimulatableException,
  SandboxUnavailableException,
} from './sandbox.errors';

const SANDBOX_CUSTOMER = 'customer@sandbox.finstack.test';

/**
 * Plays the provider's and the customer's part for payments and payouts
 * that went to the mock provider. Only where the mock provider is enabled
 * (development and SANDBOX_MODE deployments). Every simulation goes through
 * the real pipeline: a signed webhook is received and processed, exactly
 * as a provider's would be.
 */
@Injectable()
export class SandboxService {
  constructor(
    private readonly providers: PaymentProvidersService,
    private readonly mock: MockPaymentProvider,
    private readonly webhooks: WebhooksService,
    private readonly payments: PaymentsService,
    private readonly settlement: PaymentSettlementService,
    private readonly payouts: PayoutsService,
    private readonly wallets: WalletsService,
  ) {}

  /** The customer pays (or fails to pay) at the mock checkout. */
  async completePayment(
    owner: OwnerRef,
    paymentId: string,
    outcome: 'successful' | 'failed',
    collectedAmount?: bigint,
  ): Promise<PaymentView> {
    this.assertAvailable();
    const { payment, transaction } = await this.payments.getOwned(
      owner,
      paymentId,
    );
    if (payment.provider !== this.mock.name || !payment.providerReference) {
      throw new NotSimulatableException(
        'Only payments started with the mock provider can be simulated',
      );
    }
    if (transaction.status !== TransactionStatus.Pending) {
      throw new NotSimulatableException(
        `The payment is already ${transaction.status}`,
      );
    }
    const { rawBody, signature } = this.mock.simulateOutcome(
      payment.providerReference,
      outcome,
      collectedAmount !== undefined ? { amount: collectedAmount } : {},
    );
    await this.webhooks.receive(this.mock.name, rawBody, {
      [MOCK_SIGNATURE_HEADER]: signature,
    });
    // Settle now too, so the response shows the result (the queued webhook
    // then finds it settled: settlement is idempotent).
    await this.settlement.settle(payment);
    return this.payments.getOwned(owner, paymentId);
  }

  /** Test money: a mock payment into the wallet, paid at once. */
  async fund(
    ownerRef: OwnerRef,
    amount: bigint,
    currency?: CurrencyCode,
  ): Promise<PaymentView> {
    this.assertAvailable();
    const owner = toOwner(ownerRef);
    const walletCurrency =
      currency ?? (await this.wallets.findPrimaryWallet(owner))?.currency;
    if (!walletCurrency) {
      throw new WalletNotFoundException('Open a wallet first');
    }
    const { payment } = await this.payments.initialize(
      owner,
      {
        amount,
        currency: toCurrencyCode(walletCurrency),
        provider: this.mock.name,
        customerEmail:
          owner.kind === 'organization' ? SANDBOX_CUSTOMER : undefined,
      },
      `sandbox-fund:${randomUUID()}`,
    );
    return this.completePayment(owner, payment.id, 'successful');
  }

  /** The bank completes, fails or returns a payout. */
  async completePayout(
    owner: OwnerRef,
    payoutId: string,
    outcome: 'successful' | 'failed' | 'reversed',
  ): Promise<PayoutView> {
    this.assertAvailable();
    const { payout } = await this.payouts.getOwned(owner, payoutId);
    if (payout.provider !== this.mock.name) {
      throw new NotSimulatableException(
        'Only payouts sent through the mock provider can be simulated',
      );
    }
    let webhook: { rawBody: Buffer; signature: string };
    try {
      webhook = this.mock.simulatePayoutOutcome(payout.reference, outcome);
    } catch {
      throw new NotSimulatableException(
        'The provider never received this payout (it was rejected or not sent)',
      );
    }
    await this.webhooks.receive(this.mock.name, webhook.rawBody, {
      [MOCK_SIGNATURE_HEADER]: webhook.signature,
    });
    await this.payouts.sync(payout.id);
    return this.payouts.getOwned(owner, payoutId);
  }

  private assertAvailable(): void {
    if (!this.providers.has(this.mock.name)) {
      throw new SandboxUnavailableException();
    }
  }
}
