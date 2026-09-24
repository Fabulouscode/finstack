import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { toCurrencyCode } from '../common/money/currency';
import type { CurrencyCode } from '../common/money/currency';
import { isUniqueViolation } from '../database/postgres-errors';
import { FxQuote } from '../fx/fx-quote.entity';
import { FxService } from '../fx/fx.service';
import { PaymentProviderError } from '../payment-providers/payment-provider';
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
  PaymentNotFoundException,
  PaymentProviderUnavailableException,
} from './payments.errors';

export interface InitializePaymentInput {
  /** Minor units of `currency`. */
  amount: bigint;
  currency: CurrencyCode;
  provider?: string;
  callbackUrl?: string;
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
    @InjectRepository(Transaction)
    private readonly transactionsRepo: Repository<Transaction>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionsService,
    private readonly providers: PaymentProvidersService,
    private readonly wallets: WalletsService,
    private readonly fx: FxService,
    private readonly users: UsersService,
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
    userId: string,
    input: InitializePaymentInput,
    idempotencyKey: string,
  ): Promise<PaymentView> {
    const existing = await this.transactions.findByIdempotencyKey(
      userId,
      idempotencyKey,
    );
    if (existing) {
      return this.ensureInitialized(
        await this.findByTransaction(existing.id),
        input.callbackUrl,
      );
    }

    const providerName = input.provider ?? this.providers.defaultName;
    this.providers.get(providerName); // fail fast on an unknown provider

    const target = await this.wallets.resolveCreditTarget(
      userId,
      input.currency,
    );
    const quote = target.requiresConversion
      ? await this.fx.createQuote({
          userId,
          sourceCurrency: input.currency,
          targetCurrency: toCurrencyCode(target.wallet.currency),
          sourceAmount: input.amount,
        })
      : null;

    let payment: Payment;
    try {
      payment = await this.dataSource.transaction(async (manager) => {
        const transaction = await this.transactions.create(manager, {
          type: TransactionType.Payment,
          status: TransactionStatus.Pending,
          userId,
          destinationWalletId: target.wallet.id,
          amount: input.amount,
          currency: input.currency,
          idempotencyKey,
          description: `Payment via ${providerName}`,
        });
        return manager.save(
          manager.create(Payment, {
            transactionId: transaction.id,
            userId,
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
      if (isUniqueViolation(error, 'uq_transactions_user_idempotency_key')) {
        const winner = await this.transactions.findByIdempotencyKey(
          userId,
          idempotencyKey,
        );
        if (winner) return this.view(await this.findByTransaction(winner.id));
      }
      throw error;
    }

    return this.ensureInitialized(payment, input.callbackUrl);
  }

  async getForUser(userId: string, paymentId: string): Promise<PaymentView> {
    const payment = await this.payments.findOneBy({ id: paymentId, userId });
    if (!payment) {
      throw new PaymentNotFoundException();
    }
    return this.view(payment);
  }

  findByProviderReference(
    provider: string,
    providerReference: string,
  ): Promise<Payment | null> {
    return this.payments.findOneBy({ provider, providerReference });
  }

  async view(payment: Payment): Promise<PaymentView> {
    const [transaction, quote] = await Promise.all([
      this.transactionsRepo.findOneByOrFail({ id: payment.transactionId }),
      payment.fxQuoteId
        ? this.fx.getQuote(payment.fxQuoteId)
        : Promise.resolve(null),
    ]);
    return { payment, transaction, quote };
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

    const user = await this.users.findById(payment.userId);
    try {
      const result = await this.providers
        .get(payment.provider)
        .initializePayment({
          reference: view.transaction.reference,
          amount: payment.amount,
          currency: payment.currency,
          customerEmail: user?.email ?? '',
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
