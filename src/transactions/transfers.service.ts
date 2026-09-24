import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppException } from '../common/http/app.exception';
import { isUniqueViolation } from '../database/postgres-errors';
import { UsersService } from '../users/users.service';
import { WalletsService } from '../wallets/wallets.service';
import { Transaction } from './transaction.entity';
import { TransactionStatus, TransactionType } from './transaction.types';
import { TransactionsService } from './transactions.service';

export class RecipientNotFoundException extends AppException {
  constructor() {
    super(
      'RECIPIENT_NOT_FOUND',
      'No user with this email',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class SelfTransferException extends AppException {
  constructor() {
    super(
      'SELF_TRANSFER',
      'You cannot transfer to yourself',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class NoWalletInCurrencyException extends AppException {
  constructor(currency: string) {
    super(
      'NO_WALLET_IN_CURRENCY',
      `You have no ${currency} wallet to send from`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class RecipientCannotReceiveException extends AppException {
  constructor(currency: string) {
    super(
      'RECIPIENT_CANNOT_RECEIVE_CURRENCY',
      `The recipient has no ${currency} wallet`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export interface TransferInput {
  recipientEmail: string;
  /** Minor units. */
  amount: bigint;
  /** Defaults to the sender's primary wallet currency. */
  currency?: string;
  description?: string;
}

/**
 * Peer-to-peer transfers between users' wallets in the same currency.
 * Synchronous: the transaction record, the ledger posting and the final
 * status commit together, or not at all.
 */
@Injectable()
export class TransfersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionsService,
    private readonly wallets: WalletsService,
    private readonly users: UsersService,
  ) {}

  async transfer(
    userId: string,
    input: TransferInput,
    idempotencyKey: string,
  ): Promise<Transaction> {
    const existing = await this.transactions.findByIdempotencyKey(
      userId,
      idempotencyKey,
    );
    if (existing) {
      return existing;
    }

    const recipient = await this.users.findByEmail(input.recipientEmail);
    if (!recipient) {
      throw new RecipientNotFoundException();
    }
    if (recipient.id === userId) {
      throw new SelfTransferException();
    }

    const currency =
      input.currency ??
      (await this.wallets.findPrimaryWallet(userId))?.currency;
    const from = currency
      ? await this.wallets.findWallet(userId, currency)
      : null;
    if (!currency || !from) {
      throw new NoWalletInCurrencyException(currency ?? 'primary');
    }
    const to = await this.wallets.findWallet(recipient.id, currency);
    if (!to) {
      throw new RecipientCannotReceiveException(currency);
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        const transaction = await this.transactions.create(manager, {
          type: TransactionType.Transfer,
          status: TransactionStatus.Processing,
          userId,
          counterpartyUserId: recipient.id,
          sourceWalletId: from.id,
          destinationWalletId: to.id,
          amount: input.amount,
          currency,
          idempotencyKey,
          description: input.description ?? null,
        });

        const posted = await this.wallets.transferWithin(manager, from, to, {
          amount: input.amount,
          reference: `transfer:${transaction.reference}`,
          description: input.description ?? 'Transfer',
          metadata: { transactionId: transaction.id },
        });

        return this.transactions.transition(
          manager,
          transaction.id,
          TransactionStatus.Successful,
          {
            ledgerTransactionId: posted.transaction.id,
            completedAt: new Date(),
          },
        );
      });
    } catch (error) {
      // A concurrent request with the same key committed first: return it.
      if (isUniqueViolation(error, 'uq_transactions_user_idempotency_key')) {
        const winner = await this.transactions.findByIdempotencyKey(
          userId,
          idempotencyKey,
        );
        if (winner) return winner;
      }
      throw error;
    }
  }
}
