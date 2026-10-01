import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { randomBytes } from 'node:crypto';
import {
  DataSource,
  EntityManager,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { isUniqueViolation } from '../database/postgres-errors';
import { LedgerService } from '../ledger/ledger.service';
import { EntryDirection } from '../ledger/ledger.types';
import { SystemAccounts } from '../ledger/system-accounts';
import { OutboxService } from '../outbox/outbox.service';
import {
  PaymentProviderError,
  RefundPaymentResult,
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
import { applyMoneyFilter } from '../common/pagination/money-filter';
import { AdminMoneyFilter } from '../common/pagination/admin-list-query.dto';
import { Cursor } from '../common/pagination/cursor';
import { keysetPage, PageOptions } from '../common/pagination/keyset-page';

const { Debit, Credit } = EntryDirection;

/**
 * A refund sent less than this long ago is never sent again, even if the
 * provider has no record of it yet: the first request may still be in
 * flight. Far longer than any provider timeout.
 */
const RESUBMIT_AFTER_MS = 5 * 60 * 1000;

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
 * 2. submit: call the provider outside any DB transaction. Never sent twice
 *    (see submit). Success completes; rejection releases the hold; an
 *    unknown outcome leaves it processing for a safe retry.
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

  /** Every refund, newest first, for staff (admin lists). */
  async search(
    filter: AdminMoneyFilter,
    page: PageOptions,
  ): Promise<{ views: RefundView[]; next: Cursor | null }> {
    const query = this.refunds.createQueryBuilder('refund');
    applyMoneyFilter(query, 'refund', filter, this.transactions);
    if (filter.paymentId) {
      query.andWhere('refund.paymentId = :paymentId', {
        paymentId: filter.paymentId,
      });
    }
    const { items, next } = await keysetPage(query, 'refund', page);
    const views: RefundView[] = [];
    for (const refund of items) views.push(await this.view(refund.id));
    return { views, next };
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
   * Re-checks refunds stuck in processing (lost or missing webhooks,
   * timeouts, provider outages), oldest first. Run by the maintenance
   * scheduler. Each goes through submit, so a refund is never sent twice,
   * and one refund's error doesn't stop the others.
   */
  async syncStale(olderThanMs: number, limit = 50): Promise<number> {
    const before = new Date(Date.now() - olderThanMs);
    const stale = await this.refunds
      .createQueryBuilder('refund')
      .where(
        this.transactions.statusIn('refund.transaction_id', [
          TransactionStatus.Processing,
        ]),
      )
      .andWhere('COALESCE(refund.submittedAt, refund.createdAt) < :before', {
        before,
      })
      .orderBy('refund.createdAt', 'ASC')
      .limit(limit)
      .getMany();

    for (const refund of stale) {
      try {
        await this.submit(refund);
      } catch (error) {
        this.logger.error(
          `Re-checking refund ${refund.reference} failed: ${String(error)}`,
        );
      }
    }
    return stale.length;
  }

  /**
   * Handles a refund webhook. The payload is never trusted: every matching
   * processing refund is re-checked with the provider. `already_final` means
   * the refunds exist but were settled earlier (e.g. synchronously).
   */
  async syncFromWebhook(
    provider: string,
    reference: string,
  ): Promise<'synced' | 'already_final' | 'not_found'> {
    // The reference is the refund's own, or the refunded payment's.
    const payment = await this.payments.findByTransactionReference(reference);
    const matching = (): SelectQueryBuilder<Refund> =>
      this.refunds
        .createQueryBuilder('refund')
        .where('refund.provider = :provider', { provider })
        .andWhere(
          payment
            ? '(refund.reference = :reference OR refund.paymentId = :paymentId)'
            : 'refund.reference = :reference',
          { reference, paymentId: payment?.id },
        );
    const candidates = await matching()
      .andWhere(
        this.transactions.statusIn('refund.transaction_id', [
          TransactionStatus.Processing,
        ]),
      )
      .getMany();

    for (const refund of candidates) {
      await this.submit(refund);
    }
    if (candidates.length > 0) return 'synced';
    return (await matching().getExists()) ? 'already_final' : 'not_found';
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

  /**
   * Sends the refund, or finds out what happened to it. Never sends twice:
   * once a refund has been sent, it is only sent again after the provider
   * confirms it has no refund with our reference (findRefund), and only one
   * caller (request, retry, webhook) can send at a time (claimSubmission).
   *
   * Only a rejection of a send fails the refund and releases the hold. When
   * a status check or lookup fails, the money may already have reached the
   * customer, so the refund stays processing until someone can tell.
   */
  private async submit(refund: Refund): Promise<void> {
    const payment = await this.payments.getById(refund.paymentId);
    const provider = this.providers.get(refund.provider);

    let result: RefundPaymentResult | null;
    try {
      result = refund.providerRefundReference
        ? await provider.getRefund(refund.providerRefundReference)
        : refund.submittedAt
          ? await provider.findRefund({
              providerReference: payment.providerReference ?? '',
              reference: refund.reference,
            })
          : null;
    } catch (error) {
      this.leaveProcessing(refund, error);
      return;
    }

    if (!result) {
      if (!(await this.claimSubmission(refund.id))) {
        return; // sent moments ago, possibly still in flight; ask later
      }
      try {
        result = await provider.refundPayment({
          providerReference: payment.providerReference ?? '',
          amount: refund.amount,
          currency: refund.currency,
          reference: refund.reference,
        });
      } catch (error) {
        if (error instanceof PaymentProviderError && !error.retryable) {
          // A definite rejection, and no earlier send of ours exists.
          await this.fail(refund.id, 'PROVIDER_REJECTED', error.message);
        } else {
          this.leaveProcessing(refund, error);
        }
        return;
      }
    }

    if (result.providerRefundReference !== refund.providerRefundReference) {
      await this.refunds.update(refund.id, {
        providerRefundReference: result.providerRefundReference,
      });
    }
    if (result.status === 'successful') {
      await this.complete(refund.id);
    } else if (result.status === 'failed') {
      await this.fail(
        refund.id,
        'REFUND_FAILED',
        'The provider reported the refund as failed',
      );
    }
  }

  /** Unknown outcome: keep the hold, stay processing, find out later. */
  private leaveProcessing(refund: Refund, error: unknown): void {
    this.logger.warn(
      `Refund ${refund.reference} left processing: ${String(error)}`,
    );
  }

  /**
   * Marks the refund as sent, unless it was sent within RESUBMIT_AFTER_MS
   * (another send may still be in flight). Only one caller wins.
   */
  private async claimSubmission(refundId: string): Promise<boolean> {
    const result = await this.refunds
      .createQueryBuilder()
      .update(Refund)
      .set({ submittedAt: () => 'now()' })
      .where('id = :id', { id: refundId })
      .andWhere(
        '(submitted_at IS NULL OR submitted_at < now() - make_interval(secs => :seconds))',
        { seconds: RESUBMIT_AFTER_MS / 1000 },
      )
      .execute();
    return (result.affected ?? 0) > 0;
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
