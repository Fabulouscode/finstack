import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { toCurrencyCode } from '../common/money/currency';
import { paymentsConfig } from '../config/payments.config';
import type { PaymentsConfig } from '../config/payments.config';
import { FxQuote } from '../fx/fx-quote.entity';
import { FxService } from '../fx/fx.service';
import { OutboxService } from '../outbox/outbox.service';
import {
  PaymentProviderError,
  VerifyPaymentResult,
} from '../payment-providers/payment-provider';
import { PaymentProvidersService } from '../payment-providers/payment-providers.service';
import { Transaction } from '../transactions/transaction.entity';
import { TransactionStatus } from '../transactions/transaction.types';
import { TransactionsService } from '../transactions/transactions.service';
import { WalletsService } from '../wallets/wallets.service';
import { Payment } from './payment.entity';
import { PaymentProviderUnavailableException } from './payments.errors';

export type SettlementOutcome =
  | 'credited'
  | 'already_settled'
  | 'still_pending'
  | 'failed'
  | 'amount_mismatch'
  | 'ignored';

const OPEN_STATUSES = [TransactionStatus.Pending, TransactionStatus.Processing];

/**
 * Turns a provider's verified view of a payment into FinStack state. Called
 * by webhooks and by the explicit verify endpoint; both paths are safe to
 * run any number of times, concurrently.
 */
@Injectable()
export class PaymentSettlementService {
  private readonly logger = new Logger(PaymentSettlementService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly providers: PaymentProvidersService,
    private readonly transactions: TransactionsService,
    private readonly wallets: WalletsService,
    private readonly fx: FxService,
    private readonly outbox: OutboxService,
    @Inject(paymentsConfig.KEY) private readonly config: PaymentsConfig,
  ) {}

  /**
   * Asks the provider for the authoritative state (webhook payloads are
   * never trusted on their own), then settles accordingly.
   */
  async settle(payment: Payment): Promise<SettlementOutcome> {
    if (!payment.providerReference) {
      return 'still_pending';
    }

    let verified: VerifyPaymentResult;
    try {
      const transaction = await this.dataSource.manager.findOneByOrFail(
        Transaction,
        {
          id: payment.transactionId,
        },
      );
      verified = await this.providers.get(payment.provider).verifyPayment({
        reference: transaction.reference,
        providerReference: payment.providerReference,
      });
    } catch (error) {
      if (error instanceof PaymentProviderError && !error.retryable) {
        this.logger.error(
          `Provider rejected verification of payment ${payment.id}: ${error.message}`,
        );
        return 'ignored';
      }
      throw new PaymentProviderUnavailableException();
    }

    switch (verified.status) {
      case 'pending':
        return 'still_pending';
      case 'failed':
        return this.fail(
          payment,
          'PAYMENT_FAILED',
          verified.failureReason ?? 'Payment failed',
        );
      case 'successful':
        if (
          verified.amount !== payment.amount ||
          verified.currency !== payment.currency
        ) {
          // Money arrived, but not what we asked for. Never credit a guess:
          // fail the payment and flag it for reconciliation.
          this.logger.error(
            `Amount mismatch on payment ${payment.id}: expected ${payment.amount} ${payment.currency}, ` +
              `provider reports ${verified.amount} ${verified.currency}`,
          );
          const outcome = await this.fail(
            payment,
            'AMOUNT_MISMATCH',
            `Provider collected ${verified.amount} ${verified.currency}; expected ${payment.amount} ${payment.currency}`,
          );
          return outcome === 'failed' ? 'amount_mismatch' : outcome;
        }
        return this.credit(payment);
    }
  }

  /**
   * Status change, wallet credit (converted if needed) and ledger postings
   * commit together. The transaction row lock serialises concurrent
   * settlements of the same payment (webhook + verify call).
   */
  private async credit(payment: Payment): Promise<SettlementOutcome> {
    return this.dataSource.transaction(async (manager) => {
      const transaction = await this.lockTransaction(
        manager,
        payment.transactionId,
      );
      if (transaction.status === TransactionStatus.Successful) {
        return 'already_settled';
      }
      if (!OPEN_STATUSES.includes(transaction.status)) {
        this.logger.error(
          `Payment ${payment.id} succeeded at the provider but is ${transaction.status}; needs manual review`,
        );
        return 'ignored';
      }

      const reference = `payment:${transaction.reference}`;
      const description = `Payment ${transaction.reference}`;
      // With a settlement hold, the money lands in pending and becomes
      // available later (SettlementReleaseService).
      const holdMs = this.config.settlementDelaySeconds * 1000;
      const into = holdMs > 0 ? 'pending' : 'available';
      const fundsAvailableAt = new Date(Date.now() + holdMs);
      let ledgerTransactionId: string;
      let credited = { amount: payment.amount, currency: payment.currency };

      if (payment.fxQuoteId) {
        const quoteId = await this.usableQuoteId(manager, payment);
        const conversion = await this.wallets.depositWithConversionWithin(
          manager,
          payment.walletId,
          {
            quoteId,
            reference,
            description,
          },
          into,
        );
        ledgerTransactionId = conversion.targetLeg.id;
        credited = {
          amount: conversion.quote.targetAmount,
          currency: conversion.quote.targetCurrency,
        };
      } else {
        const posted = await this.wallets.depositWithin(
          manager,
          payment.walletId,
          {
            amount: payment.amount,
            reference,
            description,
            metadata: { transactionId: transaction.id, paymentId: payment.id },
          },
          into,
        );
        ledgerTransactionId = posted.transaction.id;
      }

      await this.transactions.transition(
        manager,
        transaction.id,
        TransactionStatus.Successful,
        {
          ledgerTransactionId,
          providerReference: payment.providerReference,
          completedAt: new Date(),
        },
      );
      await manager.update(Payment, payment.id, {
        pendingAmount: holdMs > 0 ? credited.amount : 0n,
        fundsAvailableAt,
      });
      // Committed atomically with the credit: the event exists iff the money moved.
      await this.outbox.add(manager, {
        type: 'payment.successful',
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        payload: {
          transactionId: transaction.id,
          reference: transaction.reference,
          paymentId: payment.id,
          userId: payment.userId,
          organizationId: payment.organizationId,
          walletId: payment.walletId,
          charged: {
            amount: payment.amount.toString(),
            currency: payment.currency,
          },
          credited: {
            amount: credited.amount.toString(),
            currency: credited.currency,
          },
          fundsAvailableAt: fundsAvailableAt.toISOString(),
        },
      });
      return 'credited';
    });
  }

  /**
   * The quote locked at checkout, or a fresh one if the customer paid after
   * it expired (late payment: re-quoted at the current rate and flagged).
   */
  private async usableQuoteId(
    manager: EntityManager,
    payment: Payment,
  ): Promise<string> {
    const quote = await manager.findOneByOrFail(FxQuote, {
      id: payment.fxQuoteId ?? '',
    });
    if (quote.consumedAt !== null || quote.expiresAt.getTime() > Date.now()) {
      return quote.id;
    }

    const requote = await this.fx.createQuote({
      userId: payment.userId,
      sourceCurrency: toCurrencyCode(quote.sourceCurrency),
      targetCurrency: toCurrencyCode(quote.targetCurrency),
      sourceAmount: payment.amount,
    });
    await manager.update(Payment, payment.id, { fxQuoteId: requote.id });
    await manager
      .createQueryBuilder()
      .update(Transaction)
      .set({
        metadata: () =>
          `metadata || jsonb_build_object('lateFxRequote', true, 'originalFxQuoteId', :originalFxQuoteId::text)`,
      })
      .where('id = :id', { id: payment.transactionId })
      .setParameter('originalFxQuoteId', quote.id)
      .execute();
    this.logger.warn(
      `Payment ${payment.id} settled after its FX quote expired; re-quoted`,
    );
    return requote.id;
  }

  private async fail(
    payment: Payment,
    failureCode: string,
    failureReason: string,
  ): Promise<SettlementOutcome> {
    return this.dataSource.transaction(async (manager) => {
      const transaction = await this.lockTransaction(
        manager,
        payment.transactionId,
      );
      if (!OPEN_STATUSES.includes(transaction.status)) {
        return transaction.status === TransactionStatus.Successful
          ? 'already_settled'
          : 'failed';
      }
      await this.transactions.transition(
        manager,
        transaction.id,
        TransactionStatus.Failed,
        {
          failureCode,
          failureReason: failureReason.slice(0, 500),
          providerReference: payment.providerReference,
        },
      );
      await this.outbox.add(manager, {
        type: 'payment.failed',
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        payload: {
          transactionId: transaction.id,
          reference: transaction.reference,
          paymentId: payment.id,
          userId: payment.userId,
          organizationId: payment.organizationId,
          failureCode,
        },
      });
      return 'failed';
    });
  }

  private async lockTransaction(
    manager: EntityManager,
    id: string,
  ): Promise<Transaction> {
    return manager
      .createQueryBuilder(Transaction, 'txn')
      .setLock('pessimistic_write')
      .where('txn.id = :id', { id })
      .getOneOrFail();
  }
}
