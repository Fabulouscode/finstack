import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
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
  async post(input: PostingInput): Promise<PostedTransaction> {
    validatePosting(input);
    try {
      return await this.dataSource.transaction((manager) =>
        this.postWithin(manager, input),
      );
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
