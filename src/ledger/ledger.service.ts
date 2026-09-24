import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import type { Cursor } from '../common/pagination/cursor';
import { isUniqueViolation } from '../database/postgres-errors';
import { LedgerAccount } from './ledger-account.entity';
import { LedgerEntry } from './ledger-entry.entity';
import { LedgerTransaction } from './ledger-transaction.entity';
import {
  CurrencyMismatchException,
  InsufficientFundsException,
  InvalidPostingError,
  LedgerAccountNotFoundError,
  LedgerReferenceConflictException,
  TransactionAlreadyReversedException,
} from './ledger.errors';
import {
  EntryDirection,
  LedgerAccountType,
  normalBalanceFor,
} from './ledger.types';
import { entriesFingerprint, PostingInput, validatePosting } from './posting';

export interface CreateLedgerAccountInput {
  name: string;
  type: LedgerAccountType;
  currency: string;
  code?: string;
  allowNegativeBalance?: boolean;
}

export interface PostedTransaction {
  transaction: LedgerTransaction;
  entries: LedgerEntry[];
  /** True when the reference had already been posted and nothing changed. */
  replayed: boolean;
}

export interface PostOptions {
  /**
   * Runs inside the posting's database transaction before the ledger is
   * touched, e.g. to lock and validate the owning wallet. Throwing aborts
   * the posting.
   */
  beforePost?: (manager: EntityManager) => Promise<void>;
}

export interface EntryPage {
  entries: AccountEntry[];
  /** Pass back as `before` to fetch the next (older) page; null at the end. */
  next: EntryCursor | null;
}

export type EntryCursor = Cursor;

export interface AccountEntry {
  id: string;
  transactionId: string;
  reference: string;
  description: string;
  direction: EntryDirection;
  amount: bigint;
  currency: string;
  createdAt: Date;
}

export interface BalanceDiscrepancy {
  accountId: string;
  cachedBalance: bigint;
  computedBalance: bigint;
}

/**
 * The only way money moves. Every posting is balanced, atomic, idempotent
 * by reference, and serialised per account with row locks.
 */
@Injectable()
export class LedgerService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  createAccount(
    input: CreateLedgerAccountInput,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<LedgerAccount> {
    return manager.save(
      manager.create(LedgerAccount, {
        name: input.name,
        type: input.type,
        normalBalance: normalBalanceFor(input.type),
        currency: input.currency,
        code: input.code ?? null,
        allowNegativeBalance: input.allowNegativeBalance ?? false,
      }),
    );
  }

  /** Get-or-create a system account by its stable code (safe under concurrency). */
  async ensureSystemAccount(
    input: CreateLedgerAccountInput & { code: string },
  ): Promise<LedgerAccount> {
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(LedgerAccount)
      .values({
        name: input.name,
        type: input.type,
        normalBalance: normalBalanceFor(input.type),
        currency: input.currency,
        code: input.code,
        allowNegativeBalance: input.allowNegativeBalance ?? false,
      })
      .orIgnore()
      .execute();

    return this.dataSource.manager.findOneByOrFail(LedgerAccount, {
      code: input.code,
    });
  }

  getAccounts(ids: string[]): Promise<LedgerAccount[]> {
    return this.dataSource.manager.findBy(LedgerAccount, { id: In(ids) });
  }

  /**
   * Posts a balanced transaction in its own database transaction.
   *
   * Idempotent by `reference`: re-posting identical input returns the
   * original (`replayed: true`); different input with a used reference
   * throws LedgerReferenceConflictException. Concurrent duplicates are
   * resolved by the unique index, and the loser replays.
   */
  async post(
    input: PostingInput,
    options: PostOptions = {},
  ): Promise<PostedTransaction> {
    validatePosting(input);
    try {
      return await this.dataSource.transaction(async (manager) => {
        await options.beforePost?.(manager);
        return this.postWithin(manager, input);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'uq_ledger_transactions_reference')) {
        return this.replay(this.dataSource.manager, input);
      }
      if (isUniqueViolation(error, 'uq_ledger_transactions_reversal_of_id')) {
        throw new TransactionAlreadyReversedException();
      }
      throw error;
    }
  }

  /**
   * Posts inside a caller-owned transaction, so a posting can commit
   * atomically with other state (e.g. a payment status change). The caller
   * handles unique-violation races on `reference`.
   */
  async postWithin(
    manager: EntityManager,
    input: PostingInput,
  ): Promise<PostedTransaction> {
    const amount = validatePosting(input);

    const existing = await manager.findOneBy(LedgerTransaction, {
      reference: input.reference,
    });
    if (existing) {
      return this.replay(manager, input);
    }
    if (input.reversalOfId) {
      await this.assertNotReversed(manager, input.reversalOfId);
    }

    const accounts = await this.lockAccounts(
      manager,
      input.entries.map((entry) => entry.accountId),
    );
    this.assertCurrency(accounts, input.currency);
    this.assertSufficientFunds(accounts, input);

    const transaction = await manager.save(
      manager.create(LedgerTransaction, {
        reference: input.reference,
        description: input.description,
        currency: input.currency,
        amount,
        reversalOfId: input.reversalOfId ?? null,
        metadata: input.metadata ?? {},
      }),
    );

    // Account balances are updated by a database trigger on insert.
    const entries = await manager.save(
      input.entries.map((entry) =>
        manager.create(LedgerEntry, {
          ledgerTransactionId: transaction.id,
          ledgerAccountId: entry.accountId,
          direction: entry.direction,
          amount: entry.amount,
          currency: input.currency,
        }),
      ),
    );

    return { transaction, entries, replayed: false };
  }

  /** Posts the mirror image of a transaction. Each transaction reverses at most once. */
  async reverse(
    transactionId: string,
    options: { reference: string; description: string },
  ): Promise<PostedTransaction> {
    const original = await this.dataSource.manager.findOneByOrFail(
      LedgerTransaction,
      { id: transactionId },
    );
    const entries = await this.dataSource.manager.findBy(LedgerEntry, {
      ledgerTransactionId: transactionId,
    });

    return this.post({
      reference: options.reference,
      description: options.description,
      currency: original.currency,
      reversalOfId: original.id,
      entries: entries.map((entry) => ({
        accountId: entry.ledgerAccountId,
        amount: entry.amount,
        direction:
          entry.direction === EntryDirection.Debit
            ? EntryDirection.Credit
            : EntryDirection.Debit,
      })),
    });
  }

  /**
   * Newest-first entries of an account with keyset pagination on
   * (created_at, id), served by idx_ledger_entries_account_created_id. Unlike
   * OFFSET, cost does not grow with page depth, and concurrent inserts never
   * shift pages. See docs/performance/ledger-entries-pagination.md.
   */
  async listAccountEntries(
    accountId: string,
    options: { limit: number; before?: EntryCursor },
  ): Promise<EntryPage> {
    const query = this.dataSource.manager
      .createQueryBuilder(LedgerEntry, 'entry')
      .innerJoin(LedgerTransaction, 'txn', 'txn.id = entry.ledgerTransactionId')
      .select([
        'entry.id AS id',
        'entry.ledgerTransactionId AS transaction_id',
        'txn.reference AS reference',
        'txn.description AS description',
        'entry.direction AS direction',
        'entry.amount AS amount',
        'entry.currency AS currency',
        'entry.createdAt AS created_at',
      ])
      .where('entry.ledgerAccountId = :accountId', { accountId })
      .orderBy('entry.createdAt', 'DESC')
      .addOrderBy('entry.id', 'DESC')
      // Fetch one extra row to know whether another page exists.
      .limit(options.limit + 1);

    if (options.before) {
      query.andWhere(
        '(entry.createdAt, entry.id) < (:beforeCreatedAt, :beforeId)',
        {
          beforeCreatedAt: options.before.createdAt,
          beforeId: options.before.id,
        },
      );
    }

    const rows = await query.getRawMany<{
      id: string;
      transaction_id: string;
      reference: string;
      description: string;
      direction: EntryDirection;
      amount: string;
      currency: string;
      created_at: Date;
    }>();

    const entries = rows.slice(0, options.limit).map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      reference: row.reference,
      description: row.description,
      direction: row.direction,
      amount: BigInt(row.amount),
      currency: row.currency,
      createdAt: row.created_at,
    }));
    const last = entries.at(-1);

    return {
      entries,
      next:
        rows.length > options.limit && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }

  /**
   * Accounts whose cached balance differs from the sum of their entries.
   * Should always be empty; exposed for integrity checks and reconciliation.
   */
  async findBalanceDiscrepancies(): Promise<BalanceDiscrepancy[]> {
    const rows = await this.dataSource.query<
      { account_id: string; cached: string; computed: string }[]
    >(`
      SELECT a.id AS account_id,
             a.balance AS cached,
             COALESCE(SUM(CASE WHEN e.direction = a.normal_balance
                               THEN e.amount ELSE -e.amount END), 0) AS computed
        FROM ledger_accounts a
        LEFT JOIN ledger_entries e ON e.ledger_account_id = a.id
       GROUP BY a.id
      HAVING a.balance <> COALESCE(SUM(CASE WHEN e.direction = a.normal_balance
                                           THEN e.amount ELSE -e.amount END), 0)
    `);

    return rows.map((row) => ({
      accountId: row.account_id,
      cachedBalance: BigInt(row.cached),
      computedBalance: BigInt(row.computed),
    }));
  }

  /**
   * Sum of debit-normal vs credit-normal balances per currency. In a
   * consistent double-entry ledger the two sides are always equal.
   */
  async trialBalance(
    currency: string,
  ): Promise<{ debit: bigint; credit: bigint }> {
    const [row] = await this.dataSource.query<
      { debit: string; credit: string }[]
    >(
      `SELECT COALESCE(SUM(balance) FILTER (WHERE normal_balance = 'debit'), 0) AS debit,
              COALESCE(SUM(balance) FILTER (WHERE normal_balance = 'credit'), 0) AS credit
         FROM ledger_accounts
        WHERE currency = $1`,
      [currency],
    );
    return { debit: BigInt(row?.debit ?? 0), credit: BigInt(row?.credit ?? 0) };
  }

  /**
   * SELECT ... FOR UPDATE in a consistent (id) order: concurrent postings
   * touching the same accounts queue up instead of deadlocking.
   */
  private async lockAccounts(
    manager: EntityManager,
    ids: string[],
  ): Promise<Map<string, LedgerAccount>> {
    const unique = [...new Set(ids)].sort();
    const accounts = await manager
      .createQueryBuilder(LedgerAccount, 'account')
      .where('account.id IN (:...ids)', { ids: unique })
      .orderBy('account.id')
      .setLock('pessimistic_write')
      .getMany();

    if (accounts.length !== unique.length) {
      const found = new Set(accounts.map((account) => account.id));
      throw new LedgerAccountNotFoundError(
        unique.filter((id) => !found.has(id)),
      );
    }
    return new Map(accounts.map((account) => [account.id, account]));
  }

  private assertCurrency(
    accounts: Map<string, LedgerAccount>,
    currency: string,
  ): void {
    for (const account of accounts.values()) {
      if (account.currency !== currency) {
        throw new CurrencyMismatchException();
      }
    }
  }

  /** Checked against the locked (current) balances, so it cannot be raced. */
  private assertSufficientFunds(
    accounts: Map<string, LedgerAccount>,
    input: PostingInput,
  ): void {
    const deltas = new Map<string, bigint>();
    for (const entry of input.entries) {
      const account = accounts.get(entry.accountId);
      if (!account) {
        throw new LedgerAccountNotFoundError([entry.accountId]);
      }
      const signed =
        entry.direction === account.normalBalance
          ? entry.amount
          : -entry.amount;
      deltas.set(account.id, (deltas.get(account.id) ?? 0n) + signed);
    }

    for (const [accountId, delta] of deltas) {
      const account = accounts.get(accountId);
      if (
        account &&
        !account.allowNegativeBalance &&
        account.balance + delta < 0n
      ) {
        throw new InsufficientFundsException();
      }
    }
  }

  /** The unique index on reversal_of_id is the backstop for concurrent reversals. */
  private async assertNotReversed(
    manager: EntityManager,
    transactionId: string,
  ): Promise<void> {
    const reversal = await manager.findOneBy(LedgerTransaction, {
      reversalOfId: transactionId,
    });
    if (reversal) {
      throw new TransactionAlreadyReversedException();
    }
  }

  private async replay(
    manager: EntityManager,
    input: PostingInput,
  ): Promise<PostedTransaction> {
    const transaction = await manager.findOneByOrFail(LedgerTransaction, {
      reference: input.reference,
    });
    const entries = await manager.findBy(LedgerEntry, {
      ledgerTransactionId: transaction.id,
    });

    const sameEntries =
      entriesFingerprint(
        entries.map((entry) => ({
          accountId: entry.ledgerAccountId,
          direction: entry.direction,
          amount: entry.amount,
        })),
      ) === entriesFingerprint(input.entries);

    if (
      transaction.currency !== input.currency ||
      transaction.description !== input.description ||
      !sameEntries
    ) {
      throw new LedgerReferenceConflictException();
    }
    if (entries.length === 0) {
      throw new InvalidPostingError('existing transaction has no entries');
    }

    return { transaction, entries, replayed: true };
  }
}
