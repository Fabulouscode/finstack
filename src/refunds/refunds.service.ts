import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { randomBytes } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { isUniqueViolation } from '../database/postgres-errors';
import { LedgerService } from '../ledger/ledger.service';
import { EntryDirection } from '../ledger/ledger.types';
import { SystemAccounts } from '../ledger/system-accounts';
import { OutboxService } from '../outbox/outbox.service';
import {
  PaymentProviderError,
  ProviderPaymentStatus,
} from '../payment-providers/payment-provider';
import { FxService } from '../fx/fx.service';
import { PaymentsService } from '../payments/payments.service';
import { PaymentProvidersService } from '../payment-providers/payment-providers.service';
import { Payment } from '../payments/payment.entity';
import { Transaction } from '../transactions/transaction.entity';
import {
  TransactionStatus,
  TransactionType,
} from '../transactions/transaction.types';
import { TransactionsService } from '../transactions/transactions.service';
import { WalletsService } from '../wallets/wallets.service';
import { Refund } from './refund.entity';
import { ConversionReversal, reverseConversion } from './refund-math';
import {
  PaymentAlreadyRefundedException,
  PaymentNotRefundableException,
  RefundExceedsRemainingException,
  RefundNotFoundException,
} from './refunds.errors';

const { Debit, Credit } = EntryDirection;

export interface RefundView {
  refund: Refund;
  transaction: Transaction;
}

/**
 * Refunds, in three steps:
 *
 * 1. request: in one DB transaction, lock the payment, check the remaining
 *    refundable amount, create the refund and HOLD the wallet amount
 *    (available -> reserved). Insufficient funds fail here, before any
 *    provider call.
 * 2. submit: call the provider outside any DB transaction, idempotent by the
 *    refund reference. Success completes; rejection releases the hold; an
 *    outage leaves it processing for a safe retry.
 * 3. complete / fail: in one DB transaction, move the held funds out
 *    (reversing the original FX conversion proportionally) or release them.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly providers: PaymentProvidersService,
    private readonly transactions: TransactionsService,
    private readonly payments: PaymentsService,
    private readonly fx: FxService,
    private readonly wallets: WalletsService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async request(
    adminId: string,
    paymentId: string,
    input: { amount?: bigint; reason: string },
    idempotencyKey: string,
  ): Promise<RefundView> {
    const existing = await this.refunds.findOneBy({
      requestedByUserId: adminId,
      idempotencyKey,
    });
    if (existing) {
      return this.view(existing.id);
    }

    let refund: Refund;
    try {
      refund = await this.dataSource.transaction((manager) =>
        this.createWithHold(manager, adminId, paymentId, input, idempotencyKey),
      );
    } catch (error) {
      if (isUniqueViolation(error, 'uq_refunds_requested_by_idempotency_key')) {
        const winner = await this.refunds.findOneBy({
          requestedByUserId: adminId,
          idempotencyKey,
        });
        if (winner) return this.view(winner.id);
      }
      throw error;
    }

    await this.submit(refund);
    return this.view(refund.id);
  }

  async view(refundId: string): Promise<RefundView> {
    const found = await this.refunds.findOneBy({ id: refundId });
    if (!found) {
      throw new RefundNotFoundException();
    }
    const transaction = await this.transactions.getById(found.transactionId);
    // Re-read after the status (see PaymentsService.view).
    const refund = await this.refunds.findOneByOrFail({ id: refundId });
    return { refund, transaction };
  }

  /** Refunds still processing, and since when (admin overview). */
  async processingStats(): Promise<{ count: number; oldest: Date | null }> {
    const row = await this.refunds
      .createQueryBuilder('refund')
      .select('COUNT(*)::int', 'count')
      .addSelect('MIN(refund.createdAt)', 'oldest')
      .where(
        this.transactions.statusIn('refund.transaction_id', [
          TransactionStatus.Processing,
        ]),
      )
      .getRawOne<{ count: number; oldest: Date | null }>();
    return { count: row?.count ?? 0, oldest: row?.oldest ?? null };
  }

  /** Re-asks the provider about a refund still processing (safe to repeat). */
  async retry(refundId: string): Promise<RefundView> {
    const { refund, transaction } = await this.view(refundId);
    if (transaction.status === TransactionStatus.Processing) {
      await this.audit.record(undefined, {
        action: AuditAction.RefundRetried,
        organizationId: transaction.organizationId,
        targetType: 'refund',
        targetId: refund.id,
      });
      await this.submit(refund);
    }
    return this.view(refundId);
  }

  /**
   * Handles a refund webhook. The payload is never trusted: every matching
   * processing refund is re-checked with the provider.
   */
  async syncFromWebhook(provider: string, reference: string): Promise<number> {
    // The reference is the refund's own, or the refunded payment's.
    const payment = await this.payments.findByTransactionReference(reference);
    const candidates = await this.refunds
      .createQueryBuilder('refund')
      .where('refund.provider = :provider', { provider })
      .andWhere(
        this.transactions.statusIn('refund.transaction_id', [
          TransactionStatus.Processing,
        ]),
      )
      .andWhere(
        payment
          ? '(refund.reference = :reference OR refund.paymentId = :paymentId)'
          : 'refund.reference = :reference',
        { reference, paymentId: payment?.id },
      )
      .getMany();

    for (const refund of candidates) {
      await this.submit(refund);
    }
    return candidates.length;
  }

  // ---- Step 1 -----------------------------------------------------------------

  private async createWithHold(
    manager: EntityManager,
    adminId: string,
    paymentId: string,
    input: { amount?: bigint; reason: string },
    idempotencyKey: string,
  ): Promise<Refund> {
    // Serialises concurrent refunds of one payment, so the remaining amount
    // can't be over-committed.
    const payment = await this.payments.lockWithin(manager, paymentId);
    const paymentTransaction = await this.transactions.getById(
      payment.transactionId,
      manager,
    );
    if (paymentTransaction.status === TransactionStatus.Reversed) {
      throw new PaymentAlreadyRefundedException();
    }
    if (paymentTransaction.status !== TransactionStatus.Successful) {
      throw new PaymentNotRefundableException(paymentTransaction.status);
    }

    const refundedBefore = await this.committedAmount(manager, payment.id);
    const remaining = payment.amount - refundedBefore;
    const amount = input.amount ?? remaining;
    if (amount <= 0n || amount > remaining) {
      throw new RefundExceedsRemainingException(remaining, payment.currency);
    }

    const wallet = await this.wallets.getWallet(payment.walletId);
    const reversal = await this.reversal(
      manager,
      payment,
      refundedBefore,
      amount,
    );
    const reference = `rfd_${randomBytes(10).toString('hex')}`;

    const transaction = await this.transactions.create(manager, {
      type: TransactionType.Refund,
      status: TransactionStatus.Processing,
      userId: payment.userId,
      organizationId: payment.organizationId,
      sourceWalletId: wallet.id,
      amount: reversal.walletDebit,
      currency: wallet.currency,
      description: `Refund of payment ${paymentTransaction.reference}`,
      metadata: {
        paymentId: payment.id,
        refundReference: reference,
        refunded: { amount: amount.toString(), currency: payment.currency },
        requestedBy: adminId,
      },
    });

    // While the payment is in its settlement hold, the refund is funded from
    // that payment's pending credit first, then from the available balance.
    const fromPending =
      payment.pendingAmount < reversal.walletDebit
        ? payment.pendingAmount
        : reversal.walletDebit;
    await this.wallets.reserveSplitWithin(manager, wallet.id, {
      amount: reversal.walletDebit,
      fromPending,
      reference: `refund-hold:${reference}`,
      description: `Hold for refund ${reference}`,
      metadata: { transactionId: transaction.id },
    });
    if (fromPending > 0n) {
      await this.payments.setHeldAmountWithin(
        manager,
        payment.id,
        payment.pendingAmount - fromPending,
      );
    }

    const refund = await manager.save(
      manager.create(Refund, {
        reference,
        paymentId: payment.id,
        transactionId: transaction.id,
        amount,
        currency: payment.currency,
        walletId: wallet.id,
        walletDebitAmount: reversal.walletDebit,
        pendingHoldAmount: fromPending,
        walletCurrency: wallet.currency,
        revenueReversal: reversal.revenueReversal,
        grossReversal: reversal.grossReversal,
        provider: payment.provider,
        providerRefundReference: null,
        reason: input.reason,
        requestedByUserId: adminId,
        idempotencyKey,
      }),
    );
    await this.audit.record(manager, {
      action: AuditAction.RefundRequested,
      organizationId: payment.organizationId,
      targetType: 'refund',
      targetId: refund.id,
      metadata: {
        paymentId: payment.id,
        amount: amount.toString(),
        currency: payment.currency,
        reason: input.reason,
      },
    });
    return refund;
  }

  /** Refunds that are processing or successful (not failed) count against the payment. */
  private async committedAmount(
    manager: EntityManager,
    paymentId: string,
  ): Promise<bigint> {
    const [row] = await manager.query<{ total: string | null }[]>(
      `SELECT SUM(r.amount) AS total
         FROM refunds r
        WHERE r.payment_id = $1
          AND ${this.transactions.statusIn('r.transaction_id', [TransactionStatus.Processing, TransactionStatus.Successful])}`,
      [paymentId],
    );
    return BigInt(row?.total ?? 0);
  }

  private async reversal(
    manager: EntityManager,
    payment: Payment,
    refundedBefore: bigint,
    amount: bigint,
  ): Promise<ConversionReversal> {
    if (!payment.fxQuoteId) {
      return {
        walletDebit: amount,
        revenueReversal: 0n,
        grossReversal: amount,
      };
    }
    // The quote actually used for the credit (a re-quote for late payments).
    const quote = await this.fx.getQuoteWithin(manager, payment.fxQuoteId);
    return reverseConversion(
      {
        charged: quote.sourceAmount,
        credited: quote.targetAmount,
        gross: quote.grossTargetAmount,
      },
      refundedBefore,
      amount,
    );
  }

  // ---- Step 2 -----------------------------------------------------------------

  private async submit(refund: Refund): Promise<void> {
    const payment = await this.payments.getById(refund.paymentId);
    const provider = this.providers.get(refund.provider);

    let status: ProviderPaymentStatus;
    try {
      if (refund.providerRefundReference) {
        status = (await provider.getRefund(refund.providerRefundReference))
          .status;
      } else {
        const result = await provider.refundPayment({
          providerReference: payment.providerReference ?? '',
          amount: refund.amount,
          currency: refund.currency,
          reference: refund.reference,
        });
        await this.refunds.update(refund.id, {
          providerRefundReference: result.providerRefundReference,
        });
        status = result.status;
      }
    } catch (error) {
      if (error instanceof PaymentProviderError && !error.retryable) {
        await this.fail(refund.id, 'PROVIDER_REJECTED', error.message);
      } else {
        // Unknown outcome: keep the hold, stay processing, retry later.
        this.logger.warn(
          `Refund ${refund.reference} left processing: ${String(error)}`,
        );
      }
      return;
    }

    if (status === 'successful') {
      await this.complete(refund.id);
    } else if (status === 'failed') {
      await this.fail(
        refund.id,
        'REFUND_FAILED',
        'The provider reported the refund as failed',
      );
    }
  }

  // ---- Step 3 -----------------------------------------------------------------

  private async complete(refundId: string): Promise<void> {
    const refund = await this.refunds.findOneByOrFail({ id: refundId });
    const walletClearing = await this.ledger.ensureSystemAccount(
      SystemAccounts.externalClearing(refund.walletCurrency),
    );
    // Present only for refunds of converted payments.
    const fx =
      refund.currency === refund.walletCurrency
        ? null
        : {
            walletPosition: await this.ledger.ensureSystemAccount(
              SystemAccounts.fxPosition(refund.walletCurrency),
            ),
            walletRevenue: await this.ledger.ensureSystemAccount(
              SystemAccounts.fxRevenue(refund.walletCurrency),
            ),
            chargedPosition: await this.ledger.ensureSystemAccount(
              SystemAccounts.fxPosition(refund.currency),
            ),
            chargedClearing: await this.ledger.ensureSystemAccount(
              SystemAccounts.externalClearing(refund.currency),
            ),
          };

    await this.dataSource.transaction(async (manager) => {
      const transaction = await this.transactions.lockWithin(
        manager,
        refund.transactionId,
      );
      if (transaction.status !== TransactionStatus.Processing) {
        return; // already settled by a concurrent webhook or retry
      }
      const wallet = await this.wallets.getWallet(refund.walletId);

      // Wallet-currency leg: the held funds leave the wallet.
      const walletLeg = await this.ledger.postWithin(manager, {
        reference: `refund:${refund.reference}`,
        description: `Refund ${refund.reference}`,
        currency: refund.walletCurrency,
        metadata: { refundId: refund.id },
        entries: fx
          ? [
              {
                accountId: wallet.reservedAccountId,
                direction: Debit,
                amount: refund.walletDebitAmount,
              },
              ...(refund.revenueReversal > 0n
                ? [
                    {
                      accountId: fx.walletRevenue.id,
                      direction: Debit,
                      amount: refund.revenueReversal,
                    },
                  ]
                : []),
              {
                accountId: fx.walletPosition.id,
                direction: Credit,
                amount: refund.grossReversal,
              },
            ]
          : [
              {
                accountId: wallet.reservedAccountId,
                direction: Debit,
                amount: refund.walletDebitAmount,
              },
              {
                accountId: walletClearing.id,
                direction: Credit,
                amount: refund.walletDebitAmount,
              },
            ],
      });

      if (fx) {
        // Charged-currency leg: the original amount goes back out through the provider.
        await this.ledger.postWithin(manager, {
          reference: `refund:${refund.reference}:fx-source`,
          description: `Refund ${refund.reference} (${refund.currency} leg)`,
          currency: refund.currency,
          metadata: { refundId: refund.id },
          entries: [
            {
              accountId: fx.chargedPosition.id,
              direction: Debit,
              amount: refund.amount,
            },
            {
              accountId: fx.chargedClearing.id,
              direction: Credit,
              amount: refund.amount,
            },
          ],
        });
      }

      await this.transactions.transition(
        manager,
        transaction.id,
        TransactionStatus.Successful,
        {
          ledgerTransactionId: walletLeg.transaction.id,
          providerReference: refund.providerRefundReference,
          completedAt: new Date(),
        },
      );

      await this.markPaymentReversedIfFullyRefunded(manager, refund.paymentId);

      await this.outbox.add(manager, {
        type: 'refund.successful',
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        payload: {
          refundId: refund.id,
          reference: refund.reference,
          paymentId: refund.paymentId,
          userId: transaction.userId,
          organizationId: transaction.organizationId,
          refunded: {
            amount: refund.amount.toString(),
            currency: refund.currency,
          },
          walletDebit: {
            amount: refund.walletDebitAmount.toString(),
            currency: refund.walletCurrency,
          },
        },
      });
    });
  }

  private async fail(
    refundId: string,
    failureCode: string,
    failureReason: string,
  ): Promise<void> {
    const refund = await this.refunds.findOneByOrFail({ id: refundId });

    await this.dataSource.transaction(async (manager) => {
      const transaction = await this.transactions.lockWithin(
        manager,
        refund.transactionId,
      );
      if (transaction.status !== TransactionStatus.Processing) {
        return;
      }
      const toPending = await this.returnToPending(manager, refund);
      await this.wallets.releaseSplitWithin(manager, refund.walletId, {
        amount: refund.walletDebitAmount,
        fromPending: toPending,
        reference: `refund-release:${refund.reference}`,
        description: `Release hold for failed refund ${refund.reference}`,
      });
      await this.transactions.transition(
        manager,
        transaction.id,
        TransactionStatus.Failed,
        {
          failureCode,
          failureReason: failureReason.slice(0, 500),
        },
      );
      await this.outbox.add(manager, {
        type: 'refund.failed',
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        payload: {
          refundId: refund.id,
          reference: refund.reference,
          paymentId: refund.paymentId,
          userId: transaction.userId,
          organizationId: transaction.organizationId,
          failureCode,
        },
      });
    });
  }

  /**
   * How much of a failed refund's hold goes back to pending: the part taken
   * from the payment's settlement hold, if that hold hasn't ended yet (then
   * the payment's pending credit grows back). Otherwise it all becomes
   * available.
   */
  private async returnToPending(
    manager: EntityManager,
    refund: Refund,
  ): Promise<bigint> {
    if (refund.pendingHoldAmount === 0n) {
      return 0n;
    }
    const payment = await this.payments.lockWithin(manager, refund.paymentId);
    const stillHeld =
      payment.pendingAmount > 0n ||
      (payment.fundsAvailableAt !== null &&
        payment.fundsAvailableAt.getTime() > Date.now());
    if (!stillHeld) {
      return 0n;
    }
    await this.payments.setHeldAmountWithin(
      manager,
      payment.id,
      payment.pendingAmount + refund.pendingHoldAmount,
    );
    return refund.pendingHoldAmount;
  }

  private async markPaymentReversedIfFullyRefunded(
    manager: EntityManager,
    paymentId: string,
  ): Promise<void> {
    const payment = await this.payments.getById(paymentId, manager);
    const [row] = await manager.query<{ total: string | null }[]>(
      `SELECT SUM(r.amount) AS total
         FROM refunds r
        WHERE r.payment_id = $1
          AND ${this.transactions.statusIn('r.transaction_id', [TransactionStatus.Successful])}`,
      [paymentId],
    );
    if (BigInt(row?.total ?? 0) === payment.amount) {
      await this.transactions.transition(
        manager,
        payment.transactionId,
        TransactionStatus.Reversed,
      );
    }
  }
}
