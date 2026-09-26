import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { toCurrencyCode } from '../common/money/currency';
import type { CurrencyCode } from '../common/money/currency';
import {
  Owner,
  OwnerRef,
  ownerColumns,
  ownerUserId,
  ownerWhere,
  toOwner,
} from '../common/owner/owner';
import { isUniqueViolation } from '../database/postgres-errors';
import { FxQuote } from '../fx/fx-quote.entity';
import { FeeOperation } from '../fees/fee-rule.entity';
import { FeesService } from '../fees/fees.service';
import { FxService } from '../fx/fx.service';
import {
  PaymentProviderError,
  TimeRange,
} from '../payment-providers/payment-provider';
import { PaymentProvidersService } from '../payment-providers/payment-providers.service';
import { Transaction } from '../transactions/transaction.entity';
import {
  TransactionStatus,
  TransactionType,
} from '../transactions/transaction.types';
import { TransactionsService } from '../transactions/transactions.service';
import { UsersService } from '../users/users.service';
import { WalletsService } from '../wallets/wallets.service';
import { Payment } from './payment.entity';
import {
  CustomerEmailRequiredException,
  PaymentNotFoundException,
  PaymentProviderUnavailableException,
} from './payments.errors';

export interface InitializePaymentInput {
  /** Minor units of `currency`. */
  amount: bigint;
  currency: CurrencyCode;
  provider?: string;
  callbackUrl?: string;
  /**
   * Who pays. Required for organization payments (the payer is a customer);
   * user top-ups default to the user's own email.
   */
  customerEmail?: string;
}

/** A payment with its transaction (status) and FX quote (if converting). */
export interface PaymentView {
  payment: Payment;
  transaction: Transaction;
  quote: FxQuote | null;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionsService,
    private readonly providers: PaymentProvidersService,
    private readonly wallets: WalletsService,
    private readonly fx: FxService,
    private readonly users: UsersService,
    private readonly fees: FeesService,
  ) {}

  /**
   * Creates a pending payment and a hosted checkout with the provider.
   *
   * 1. Crediting rule picks the wallet; a foreign currency gets a locked FX quote.
   * 2. Transaction (pending) + payment rows are committed.
   * 3. The provider is called outside any database transaction.
   *
   * Idempotent by Idempotency-Key: a retry returns the same payment and, if
   * the provider call had failed transiently, re-initialises it (providers
   * treat our reference as idempotent).
   */
  async initialize(
    ownerRef: OwnerRef,
    input: InitializePaymentInput,
    idempotencyKey: string,
  ): Promise<PaymentView> {
    const owner = toOwner(ownerRef);
    const existing = await this.transactions.findByIdempotencyKey(
      owner,
      idempotencyKey,
    );
    if (existing) {
      return this.ensureInitialized(
        await this.findByTransaction(existing.id),
        input.callbackUrl,
      );
    }

    // Fails fast (before creating any records) on routing or currency errors.
    const providerName = this.providers.select(
      input.currency,
      input.provider,
    ).name;

    const customerEmail = await this.customerEmailFor(owner, input);

    const target = await this.wallets.resolveCreditTarget(
      owner,
      input.currency,
    );
    const quote = target.requiresConversion
      ? await this.fx.createQuote({
          userId: ownerUserId(owner),
          sourceCurrency: input.currency,
          targetCurrency: toCurrencyCode(target.wallet.currency),
          sourceAmount: input.amount,
        })
      : null;

    // The fee is on what the wallet receives (after conversion), taken from
    // the credit, and locked now like the quote.
    const fee = await this.fees.quoteCovered({
      operation: FeeOperation.Payment,
      currency: target.wallet.currency,
      amount: quote ? quote.targetAmount : input.amount,
      organizationId: owner.kind === 'organization' ? owner.id : null,
    });

    let payment: Payment;
    try {
      payment = await this.dataSource.transaction(async (manager) => {
        const transaction = await this.transactions.create(manager, {
          type: TransactionType.Payment,
          status: TransactionStatus.Pending,
          ...ownerColumns(owner),
          destinationWalletId: target.wallet.id,
          amount: input.amount,
          currency: input.currency,
          idempotencyKey,
          description: `Payment via ${providerName}`,
          ...(fee.amount > 0n
            ? {
                feeAmount: fee.amount,
                feeCurrency: fee.currency,
                feeRuleId: fee.ruleId,
              }
            : {}),
        });
        return manager.save(
          manager.create(Payment, {
            transactionId: transaction.id,
            ...ownerColumns(owner),
            customerEmail,
            walletId: target.wallet.id,
            provider: providerName,
            providerReference: null,
            authorizationUrl: null,
            amount: input.amount,
            currency: input.currency,
            fxQuoteId: quote?.id ?? null,
          }),
        );
      });
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
        if (winner) return this.view(await this.findByTransaction(winner.id));
      }
      throw error;
    }

    return this.ensureInitialized(payment, input.callbackUrl);
  }

  async getOwned(owner: OwnerRef, paymentId: string): Promise<PaymentView> {
    const payment = await this.payments.findOneBy({
      id: paymentId,
      ...ownerWhere(owner),
    });
    if (!payment) {
      throw new PaymentNotFoundException();
    }
    return this.view(payment);
  }

  async getById(id: string, manager?: EntityManager): Promise<Payment> {
    const payment = await (manager ?? this.payments.manager).findOneBy(
      Payment,
      { id },
    );
    if (!payment) {
      throw new PaymentNotFoundException();
    }
    return payment;
  }

  /** Locks the payment row for the caller's database transaction. */
  async lockWithin(manager: EntityManager, id: string): Promise<Payment> {
    const payment = await manager
      .createQueryBuilder(Payment, 'payment')
      .setLock('pessimistic_write')
      .where('payment.id = :id', { id })
      .getOne();
    if (!payment) {
      throw new PaymentNotFoundException();
    }
    return payment;
  }

  /**
   * Sets how much of the payment's credit is still in its settlement hold
   * (refunds take from it and may give it back). Call with the payment
   * locked (lockWithin).
   */
  async setHeldAmountWithin(
    manager: EntityManager,
    paymentId: string,
    pendingAmount: bigint,
  ): Promise<void> {
    await manager.update(Payment, paymentId, { pendingAmount });
  }

  /** The payment whose transaction has this reference (`trx_...`). */
  async findByTransactionReference(reference: string): Promise<Payment | null> {
    const transaction = await this.transactions.findByReference(reference);
    return transaction
      ? this.payments.findOneBy({ transactionId: transaction.id })
      : null;
  }

  /** Payments routed to `provider` and created in the range (reconciliation). */
  listForProvider(provider: string, range: TimeRange): Promise<Payment[]> {
    return this.payments
      .createQueryBuilder('payment')
      .where('payment.provider = :provider', { provider })
      .andWhere('payment.createdAt >= :from AND payment.createdAt < :to', range)
      .getMany();
  }

  findByProviderReference(
    provider: string,
    providerReference: string,
  ): Promise<Payment | null> {
    return this.payments.findOneBy({ provider, providerReference });
  }

  /**
   * The payment with its status. The transaction is read first and the
   * payment again after it: settlement updates both in one commit, so a
   * successful status always comes with its credit details (the other order
   * could pair a new status with an old payment row).
   */
  async view(payment: Payment): Promise<PaymentView> {
    const transaction = await this.transactions.getById(payment.transactionId);
    const current = await this.payments.findOneByOrFail({ id: payment.id });
    const quote = current.fxQuoteId
      ? await this.fx.getQuote(current.fxQuoteId)
      : null;
    return { payment: current, transaction, quote };
  }

  private async customerEmailFor(
    owner: Owner,
    input: InitializePaymentInput,
  ): Promise<string> {
    if (input.customerEmail) {
      return input.customerEmail;
    }
    if (owner.kind === 'organization') {
      throw new CustomerEmailRequiredException();
    }
    const user = await this.users.findById(owner.id);
    if (!user) {
      throw new PaymentNotFoundException();
    }
    return user.email;
  }

  private async findByTransaction(transactionId: string): Promise<Payment> {
    const payment = await this.payments.findOneBy({ transactionId });
    if (!payment) {
      throw new PaymentNotFoundException();
    }
    return payment;
  }

  /** Calls the provider unless this payment already has a checkout. */
  private async ensureInitialized(
    payment: Payment,
    callbackUrl?: string,
  ): Promise<PaymentView> {
    const view = await this.view(payment);
    if (
      payment.providerReference ||
      view.transaction.status !== TransactionStatus.Pending
    ) {
      return view;
    }

    try {
      const result = await this.providers
        .get(payment.provider)
        .initializePayment({
          reference: view.transaction.reference,
          amount: payment.amount,
          currency: payment.currency,
          customerEmail: payment.customerEmail,
          callbackUrl,
        });
      await this.payments.update(payment.id, {
        providerReference: result.providerReference,
        authorizationUrl: result.authorizationUrl,
      });
    } catch (error) {
      if (error instanceof PaymentProviderError && !error.retryable) {
        // A definite rejection: the payment can never complete.
        await this.dataSource.transaction((manager) =>
          this.transactions.transition(
            manager,
            payment.transactionId,
            TransactionStatus.Failed,
            {
              failureCode: 'PROVIDER_REJECTED',
              failureReason: error.message.slice(0, 500),
            },
          ),
        );
      } else {
        // Outage or timeout: the charge may or may not exist. Stay pending.
        this.logger.warn(
          `Provider ${payment.provider} unavailable for payment ${payment.id}: ${String(error)}`,
        );
        throw new PaymentProviderUnavailableException();
      }
    }

    return this.view(await this.payments.findOneByOrFail({ id: payment.id }));
  }
}
