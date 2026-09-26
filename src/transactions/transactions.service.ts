import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import {
  Brackets,
  EntityManager,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { AppException } from '../common/http/app.exception';
import { OwnerRef, ownerWhere } from '../common/owner/owner';
import type { Cursor } from '../common/pagination/cursor';
import { sqlList } from '../ledger/ledger.types';
import { Transaction } from './transaction.entity';
import { assertTransition, TransactionStatus } from './transaction.types';

export class TransactionNotFoundException extends AppException {
  constructor() {
    super(
      'TRANSACTION_NOT_FOUND',
      'Transaction not found',
      HttpStatus.NOT_FOUND,
    );
  }
}

/** Set exactly one of `userId` and `organizationId` (the owner). */
export type NewTransaction = Pick<
  Transaction,
  'type' | 'status' | 'amount' | 'currency'
> &
  Partial<
    Pick<
      Transaction,
      | 'userId'
      | 'organizationId'
      | 'counterpartyUserId'
      | 'sourceWalletId'
      | 'destinationWalletId'
      | 'providerReference'
      | 'idempotencyKey'
      | 'description'
      | 'metadata'
      | 'feeAmount'
      | 'feeCurrency'
      | 'feeRuleId'
    >
  >;

export type TransitionPatch = Partial<
  Pick<
    Transaction,
    | 'ledgerTransactionId'
    | 'providerReference'
    | 'failureCode'
    | 'failureReason'
    | 'completedAt'
  >
>;

export interface TransactionPage {
  transactions: Transaction[];
  next: Cursor | null;
}

/** Public reference: `trx_` + 20 hex chars (80 random bits). */
export function generateReference(): string {
  return `trx_${randomBytes(10).toString('hex')}`;
}

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
  ) {}

  create(manager: EntityManager, input: NewTransaction): Promise<Transaction> {
    return manager.save(
      manager.create(Transaction, {
        userId: null,
        organizationId: null,
        counterpartyUserId: null,
        sourceWalletId: null,
        destinationWalletId: null,
        ledgerTransactionId: null,
        providerReference: null,
        idempotencyKey: null,
        description: null,
        feeAmount: 0n,
        feeCurrency: null,
        feeRuleId: null,
        failureCode: null,
        failureReason: null,
        completedAt: null,
        metadata: {},
        ...input,
        reference: generateReference(),
      }),
    );
  }

  async getById(id: string, manager?: EntityManager): Promise<Transaction> {
    const transaction = await (manager ?? this.transactions.manager).findOneBy(
      Transaction,
      { id },
    );
    if (!transaction) {
      throw new TransactionNotFoundException();
    }
    return transaction;
  }

  findByReference(reference: string): Promise<Transaction | null> {
    return this.transactions.findOneBy({ reference });
  }

  /**
   * Locks a transaction row (SELECT ... FOR UPDATE) for the rest of the
   * caller's database transaction; used to serialise settlement of the
   * payment, refund or payout it belongs to.
   */
  async lockWithin(manager: EntityManager, id: string): Promise<Transaction> {
    const transaction = await manager
      .createQueryBuilder(Transaction, 'txn')
      .setLock('pessimistic_write')
      .where('txn.id = :id', { id })
      .getOne();
    if (!transaction) {
      throw new TransactionNotFoundException();
    }
    return transaction;
  }

  /** Adds keys to a transaction's metadata, atomically (jsonb merge). */
  async mergeMetadataWithin(
    manager: EntityManager,
    id: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(Transaction)
      .set({ metadata: () => 'metadata || :patch::jsonb' })
      .where('id = :id', { id })
      .setParameter('patch', JSON.stringify(metadata))
      .execute();
  }

  /**
   * A SQL condition for other modules' queries: "the transaction referenced
   * by `column` has one of `statuses`", so they can filter by status without
   * knowing this module's table.
   */
  statusIn(column: string, statuses: TransactionStatus[]): string {
    return `EXISTS (SELECT 1 FROM transactions txn_status WHERE txn_status.id = ${column} AND txn_status.status IN (${sqlList(statuses)}))`;
  }

  /**
   * Moves a transaction to a new status under a row lock, validating the
   * transition first. The database trigger rejects invalid transitions too.
   */
  async transition(
    manager: EntityManager,
    transactionId: string,
    to: TransactionStatus,
    patch: TransitionPatch = {},
  ): Promise<Transaction> {
    const current = await this.lockWithin(manager, transactionId);
    assertTransition(current.status, to);

    await manager.update(Transaction, transactionId, { ...patch, status: to });
    return manager.findOneByOrFail(Transaction, { id: transactionId });
  }

  findByIdempotencyKey(
    owner: OwnerRef,
    idempotencyKey: string,
  ): Promise<Transaction | null> {
    return this.transactions.findOneBy({
      ...ownerWhere(owner),
      idempotencyKey,
    });
  }

  async getForOrganization(
    organizationId: string,
    transactionId: string,
  ): Promise<Transaction> {
    const transaction = await this.transactions.findOneBy({
      id: transactionId,
      organizationId,
    });
    if (!transaction) {
      throw new TransactionNotFoundException();
    }
    return transaction;
  }

  /** The organization's transactions, newest first, keyset-paginated. */
  listForOrganization(
    organizationId: string,
    options: { limit: number; before?: Cursor },
  ): Promise<TransactionPage> {
    return this.page(
      this.transactions
        .createQueryBuilder('txn')
        .where('txn.organizationId = :organizationId', { organizationId }),
      options,
    );
  }

  /** Visible to the initiator and the counterparty; others get 404. */
  async getForUser(
    userId: string,
    transactionId: string,
  ): Promise<Transaction> {
    const transaction = await this.transactions
      .createQueryBuilder('txn')
      .where('txn.id = :transactionId', { transactionId })
      .andWhere(
        new Brackets((q) =>
          q
            .where('txn.userId = :userId')
            .orWhere('txn.counterpartyUserId = :userId'),
        ),
      )
      .setParameter('userId', userId)
      .getOne();

    if (!transaction) {
      throw new TransactionNotFoundException();
    }
    return transaction;
  }

  /** Newest first, keyset-paginated, in both directions. */
  listForUser(
    userId: string,
    options: { limit: number; before?: Cursor },
  ): Promise<TransactionPage> {
    return this.page(
      this.transactions
        .createQueryBuilder('txn')
        .where(
          new Brackets((q) =>
            q
              .where('txn.userId = :userId')
              .orWhere('txn.counterpartyUserId = :userId'),
          ),
        )
        .setParameter('userId', userId),
      options,
    );
  }

  private async page(
    base: SelectQueryBuilder<Transaction>,
    options: { limit: number; before?: Cursor },
  ): Promise<TransactionPage> {
    const query = base
      .orderBy('txn.createdAt', 'DESC')
      .addOrderBy('txn.id', 'DESC')
      .limit(options.limit + 1);

    if (options.before) {
      query.andWhere(
        '(txn.createdAt, txn.id) < (:beforeCreatedAt, :beforeId)',
        {
          beforeCreatedAt: options.before.createdAt,
          beforeId: options.before.id,
        },
      );
    }

    const rows = await query.getMany();
    const transactions = rows.slice(0, options.limit);
    const last = transactions.at(-1);

    return {
      transactions,
      next:
        rows.length > options.limit && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }
}
