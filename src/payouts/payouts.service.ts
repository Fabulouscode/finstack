import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import {
  Owner,
  OwnerRef,
  ownerColumns,
  ownerWhere,
  toOwner,
} from '../common/owner/owner';
import { isUniqueViolation } from '../database/postgres-errors';
import { CurrencyMismatchException } from '../ledger/ledger.errors';
import { LedgerService } from '../ledger/ledger.service';
import { EntryDirection } from '../ledger/ledger.types';
import { SystemAccounts } from '../ledger/system-accounts';
import { OutboxService } from '../outbox/outbox.service';
import {
  PaymentProviderError,
  PayoutResult,
} from '../payment-providers/payment-provider';
import { PaymentProvidersService } from '../payment-providers/payment-providers.service';
import { Transaction } from '../transactions/transaction.entity';
import {
  TransactionStatus,
  TransactionType,
} from '../transactions/transaction.types';
import { TransactionsService } from '../transactions/transactions.service';
import { Wallet } from '../wallets/wallet.entity';
import { WalletNotFoundException } from '../wallets/wallets.errors';
import { WalletsService } from '../wallets/wallets.service';
import { PayoutDestination } from './payout-destination.entity';
import { PayoutDestinationsService } from './payout-destinations.service';
import { Payout } from './payout.entity';
import { PayoutNotFoundException } from './payouts.errors';

const { Debit, Credit } = EntryDirection;

/**
 * A submission the provider still doesn't know after this long never
 * arrived (e.g. the process died before sending), so it may be sent again.
 */
const RESUBMIT_AFTER_MS = 5 * 60 * 1000;

export interface RequestPayoutInput {
  destinationId: string;
  /** Minor units of the wallet's currency. */
  amount: bigint;
  /** Defaults to the owner's wallet in the destination's currency. */
  walletId?: string;
  narration?: string;
}

export interface PayoutView {
  payout: Payout;
  transaction: Transaction;
  destination: PayoutDestination;
}

/** Public reference: `pyt_` + 20 hex chars. */
function generatePayoutReference(): string {
  return `pyt_${randomBytes(10).toString('hex')}`;
}

/**
 * Money out of a wallet to a bank account:
 *
 * 1. Hold: available -> reserved, with the transaction (processing) and the
 *    payout row, in one database transaction.
 * 2. Submit to the provider, outside any database transaction. Once sent,
 *    the provider is always asked about the payout (by our reference) before
 *    it is sent again, so a lost response can't pay out twice.
 * 3. Settle: success moves the held funds out (reserved -> clearing);
 *    failure releases the hold; a later provider reversal credits it back.
 */
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    @InjectRepository(Payout) private readonly payouts: Repository<Payout>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly destinations: PayoutDestinationsService,
    private readonly providers: PaymentProvidersService,
    private readonly transactions: TransactionsService,
    private readonly wallets: WalletsService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  /** Idempotent by Idempotency-Key (per owner), like payments. */
  async request(
    ownerRef: OwnerRef,
    input: RequestPayoutInput,
    idempotencyKey: string,
  ): Promise<PayoutView> {
    const owner = toOwner(ownerRef);
    const existing = await this.transactions.findByIdempotencyKey(
      owner,
      idempotencyKey,
    );
    if (existing) {
      return this.viewByTransaction(existing.id);
    }

    const destination = await this.destinations.getActive(
      owner,
      input.destinationId,
    );
    const wallet = await this.sourceWallet(owner, destination, input.walletId);
    // Fails fast if the provider can no longer pay out in this currency.
    this.providers.payoutsOf(destination.provider);

    let payout: Payout;
    try {
      payout = await this.dataSource.transaction((manager) =>
        this.createWithHold(
          manager,
          owner,
          wallet,
          destination,
          input,
          idempotencyKey,
        ),
      );
    } catch (error) {
      if (
        isUniqueViolation(error, [
          'uq_transactions_user_idempotency_key',
          'uq_transactions_org_idempotency_key',
        ])
      ) {
        const winner = await this.transactions.findByIdempotencyKey(
          owner,
          idempotencyKey,
        );
        if (winner) return this.viewByTransaction(winner.id);
      }
      throw error;
    }

    this.logger.log(`Payout ${payout.reference} requested`);
    await this.submit(payout.id);
    return this.view(payout.id);
  }

  async getOwned(owner: OwnerRef, payoutId: string): Promise<PayoutView> {
    const payout = await this.payouts.findOneBy({
      id: payoutId,
      ...ownerWhere(owner),
    });
    if (!payout) {
      throw new PayoutNotFoundException();
    }
    return this.view(payout.id);
  }

  async view(payoutId: string): Promise<PayoutView> {
    const payout = await this.payouts.findOneBy({ id: payoutId });
    if (!payout) {
      throw new PayoutNotFoundException();
    }
    const transaction = await this.dataSource.manager.findOneByOrFail(
      Transaction,
      { id: payout.transactionId },
    );
    const destination = await this.dataSource.manager.findOneByOrFail(
      PayoutDestination,
      { id: payout.destinationId },
    );
    return { payout, transaction, destination };
  }

  /** Re-checks a payout with its provider (admin action; safe to repeat). */
  async sync(payoutId: string): Promise<PayoutView> {
    await this.submit(payoutId);
    return this.view(payoutId);
  }

  /** Handles a payout webhook; the payload is only a hint to re-check. */
  async syncFromWebhook(provider: string, reference: string): Promise<boolean> {
    const payout = await this.payouts.findOneBy({ provider, reference });
    if (!payout) {
      return false;
    }
    await this.submit(payout.id);
    return true;
  }

  /**
   * Re-checks payouts left processing, e.g. after a lost webhook or a
   * provider outage. Run periodically by the maintenance worker.
   */
  async syncStale(olderThanMs: number, limit = 50): Promise<number> {
    const stale = await this.payouts
      .createQueryBuilder('payout')
      .innerJoin(Transaction, 'txn', 'txn.id = payout.transactionId')
      .where('txn.status = :status', { status: TransactionStatus.Processing })
      .andWhere('payout.createdAt < :before', {
        before: new Date(Date.now() - olderThanMs),
      })
      .orderBy('payout.createdAt', 'ASC')
      .limit(limit)
      .getMany();

    for (const payout of stale) {
      await this.submit(payout.id);
    }
    return stale.length;
  }

  // ---- Step 1 -----------------------------------------------------------------

  private async sourceWallet(
    owner: Owner,
    destination: PayoutDestination,
    walletId?: string,
  ): Promise<Wallet> {
    const wallet = walletId
      ? (await this.wallets.getOwned(owner, walletId)).wallet
      : await this.wallets.findWallet(owner, destination.currency);
    if (!wallet) {
      throw new WalletNotFoundException(
        `No ${destination.currency} wallet to pay out from`,
      );
    }
    if (wallet.currency !== destination.currency) {
      throw new CurrencyMismatchException(
        `The wallet holds ${wallet.currency}, but the destination receives ${destination.currency}`,
      );
    }
    return wallet;
  }

  private async createWithHold(
    manager: EntityManager,
    owner: Owner,
    wallet: Wallet,
    destination: PayoutDestination,
    input: RequestPayoutInput,
    idempotencyKey: string,
  ): Promise<Payout> {
    const reference = generatePayoutReference();
    const transaction = await this.transactions.create(manager, {
      type: TransactionType.Withdrawal,
      status: TransactionStatus.Processing,
      ...ownerColumns(owner),
      sourceWalletId: wallet.id,
      amount: input.amount,
      currency: wallet.currency,
      idempotencyKey,
      description:
        input.narration ??
        `Payout to ${destination.accountName} ****${destination.accountNumberLast4}`,
      metadata: { payoutReference: reference, destinationId: destination.id },
    });

    // Locks the wallet (and requires it active); fails if funds are short.
    await this.wallets.reserveWithin(manager, wallet.id, {
      amount: input.amount,
      reference: `payout-hold:${reference}`,
      description: `Hold for payout ${reference}`,
      metadata: { transactionId: transaction.id },
    });

    const payout = await manager.save(
      manager.create(Payout, {
        reference,
        transactionId: transaction.id,
        ...ownerColumns(owner),
        walletId: wallet.id,
        destinationId: destination.id,
        provider: destination.provider,
        amount: input.amount,
        currency: wallet.currency,
        narration: input.narration ?? null,
        providerReference: null,
        submittedAt: null,
      }),
    );
    await this.audit.record(manager, {
      action: AuditAction.PayoutRequested,
      organizationId: payout.organizationId,
      targetType: 'payout',
      targetId: payout.id,
      metadata: {
        amount: input.amount.toString(),
        currency: payout.currency,
        destinationId: destination.id,
        accountNumberLast4: destination.accountNumberLast4,
      },
    });
    return payout;
  }

  // ---- Step 2 -----------------------------------------------------------------

  private async submit(payoutId: string): Promise<void> {
    const { payout, transaction, destination } = await this.view(payoutId);
    if (
      transaction.status !== TransactionStatus.Processing &&
      transaction.status !== TransactionStatus.Successful
    ) {
      return; // failed or reversed: nothing left to learn
    }
    const payouts = this.providers.payoutsOf(payout.provider);

    let result: PayoutResult | null;
    try {
      result = payout.submittedAt ? await payouts.find(payout.reference) : null;

      if (!result && transaction.status === TransactionStatus.Processing) {
        if (!(await this.claimSubmission(payout.id))) {
          return; // another submission is in flight; it will settle
        }
        result = await payouts.initiate({
          reference: payout.reference,
          amount: payout.amount,
          currency: payout.currency,
          recipientReference: destination.recipientReference,
          narration: payout.narration ?? undefined,
        });
      }
    } catch (error) {
      if (
        error instanceof PaymentProviderError &&
        !error.retryable &&
        !payout.submittedAt
      ) {
        await this.fail(payout, 'PROVIDER_REJECTED', error.message);
      } else {
        // Unknown outcome: keep the hold and find out later.
        this.logger.warn(
          `Payout ${payout.reference} left processing: ${String(error)}`,
        );
      }
      return;
    }
    if (!result) {
      return;
    }

    if (result.providerReference !== payout.providerReference) {
      await this.payouts.update(payout.id, {
        providerReference: result.providerReference,
      });
      payout.providerReference = result.providerReference;
    }

    switch (result.status) {
      case 'successful':
        await this.complete(payout);
        break;
      case 'failed':
        await this.fail(
          payout,
          'PAYOUT_FAILED',
          result.failureReason ?? 'The provider reported the payout as failed',
        );
        break;
      case 'reversed':
        // Still processing here: release the hold (the money never left).
        // Already successful: credit the wallet back.
        await this.fail(
          payout,
          'PAYOUT_REVERSED',
          'The provider reversed the payout',
        );
        await this.reverse(payout);
        break;
      case 'pending':
        break;
    }
  }

  /**
   * Marks the payout as sent, unless another submission is in flight. Only
   * one caller wins, so concurrent submits (request, webhook, sweep) can't
   * both send it.
   */
  private async claimSubmission(payoutId: string): Promise<boolean> {
    const result = await this.payouts
      .createQueryBuilder()
      .update(Payout)
      .set({ submittedAt: () => 'now()' })
      .where('id = :id', { id: payoutId })
      .andWhere(
        '(submitted_at IS NULL OR submitted_at < now() - make_interval(secs => :seconds))',
        { seconds: RESUBMIT_AFTER_MS / 1000 },
      )
      .execute();
    return (result.affected ?? 0) > 0;
  }

  // ---- Step 3 -----------------------------------------------------------------

  private async complete(payout: Payout): Promise<void> {
    const clearing = await this.ledger.ensureSystemAccount(
      SystemAccounts.externalClearing(payout.currency),
    );
    await this.dataSource.transaction(async (manager) => {
      const transaction = await this.lockTransaction(
        manager,
        payout.transactionId,
      );
      if (transaction.status !== TransactionStatus.Processing) {
        return; // settled concurrently
      }
      const wallet = await manager.findOneByOrFail(Wallet, {
        id: payout.walletId,
      });
      const posted = await this.ledger.postWithin(manager, {
        reference: `payout:${payout.reference}`,
        description: `Payout ${payout.reference}`,
        currency: payout.currency,
        metadata: { payoutId: payout.id },
        entries: [
          {
            accountId: wallet.reservedAccountId,
            direction: Debit,
            amount: payout.amount,
          },
          { accountId: clearing.id, direction: Credit, amount: payout.amount },
        ],
      });
      await this.transactions.transition(
        manager,
        transaction.id,
        TransactionStatus.Successful,
        {
          ledgerTransactionId: posted.transaction.id,
          providerReference: payout.providerReference,
          completedAt: new Date(),
        },
      );
      await this.outbox.add(manager, {
        type: 'payout.successful',
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        payload: this.eventPayload(payout, transaction),
      });
    });
  }

  private async fail(
    payout: Payout,
    failureCode: string,
    failureReason: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const transaction = await this.lockTransaction(
        manager,
        payout.transactionId,
      );
      if (transaction.status !== TransactionStatus.Processing) {
        return;
      }
      await this.wallets.releaseWithin(manager, payout.walletId, {
        amount: payout.amount,
        reference: `payout-release:${payout.reference}`,
        description: `Release hold for failed payout ${payout.reference}`,
      });
      await this.transactions.transition(
        manager,
        transaction.id,
        TransactionStatus.Failed,
        { failureCode, failureReason: failureReason.slice(0, 500) },
      );
      await this.outbox.add(manager, {
        type: 'payout.failed',
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        payload: { ...this.eventPayload(payout, transaction), failureCode },
      });
    });
  }

  /** The provider returned a completed payout: credit the wallet back. */
  private async reverse(payout: Payout): Promise<void> {
    const clearing = await this.ledger.ensureSystemAccount(
      SystemAccounts.externalClearing(payout.currency),
    );
    await this.dataSource.transaction(async (manager) => {
      const transaction = await this.lockTransaction(
        manager,
        payout.transactionId,
      );
      if (transaction.status !== TransactionStatus.Successful) {
        return; // never completed (released instead) or already reversed
      }
      const wallet = await manager.findOneByOrFail(Wallet, {
        id: payout.walletId,
      });
      await this.ledger.postWithin(manager, {
        reference: `payout-reversal:${payout.reference}`,
        description: `Reversal of payout ${payout.reference}`,
        currency: payout.currency,
        metadata: { payoutId: payout.id },
        entries: [
          { accountId: clearing.id, direction: Debit, amount: payout.amount },
          {
            accountId: wallet.availableAccountId,
            direction: Credit,
            amount: payout.amount,
          },
        ],
      });
      await this.transactions.transition(
        manager,
        transaction.id,
        TransactionStatus.Reversed,
      );
      await this.outbox.add(manager, {
        type: 'payout.reversed',
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        payload: this.eventPayload(payout, transaction),
      });
    });
    this.logger.warn(`Payout ${payout.reference} was reversed by the provider`);
  }

  private eventPayload(
    payout: Payout,
    transaction: Transaction,
  ): Record<string, unknown> {
    return {
      payoutId: payout.id,
      reference: payout.reference,
      transactionId: transaction.id,
      userId: payout.userId,
      organizationId: payout.organizationId,
      walletId: payout.walletId,
      amount: payout.amount.toString(),
      currency: payout.currency,
    };
  }

  private async viewByTransaction(transactionId: string): Promise<PayoutView> {
    const payout = await this.payouts.findOneBy({ transactionId });
    if (!payout) {
      throw new PayoutNotFoundException();
    }
    return this.view(payout.id);
  }

  private lockTransaction(
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
