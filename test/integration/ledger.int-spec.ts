import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { LedgerAccount } from '../../src/ledger/ledger-account.entity';
import {
  CurrencyMismatchException,
  InsufficientFundsException,
  LedgerReferenceConflictException,
  TransactionAlreadyReversedException,
} from '../../src/ledger/ledger.errors';
import { LedgerModule } from '../../src/ledger/ledger.module';
import { LedgerService } from '../../src/ledger/ledger.service';
import {
  EntryDirection,
  LedgerAccountType,
} from '../../src/ledger/ledger.types';
import { PostingInput } from '../../src/ledger/posting';
import { createTestModule } from '../utils/create-test-module';
import { resetDatabase } from '../utils/database';

const { Debit, Credit } = EntryDirection;

describe('LedgerService (integration)', () => {
  let moduleRef: TestingModule;
  let ledger: LedgerService;
  let dataSource: DataSource;

  /** External money (e.g. a payment provider): an asset that may go negative. */
  let clearing: LedgerAccount;
  /** Customer funds we owe: liabilities that must never go negative. */
  let alice: LedgerAccount;
  let bob: LedgerAccount;

  const balanceOf = async (account: LedgerAccount): Promise<bigint> =>
    (
      await dataSource.manager.findOneByOrFail(LedgerAccount, {
        id: account.id,
      })
    ).balance;

  const transfer = (
    from: LedgerAccount,
    to: LedgerAccount,
    amount: bigint,
    reference: string,
  ): PostingInput => ({
    reference,
    description: 'Transfer',
    currency: 'NGN',
    entries: [
      { accountId: from.id, direction: Debit, amount },
      { accountId: to.id, direction: Credit, amount },
    ],
  });

  /** Moves money in from outside: debit clearing (asset), credit customer (liability). */
  const deposit = (
    to: LedgerAccount,
    amount: bigint,
    reference: string,
  ): Promise<unknown> => ledger.post(transfer(clearing, to, amount, reference));

  beforeAll(async () => {
    moduleRef = await createTestModule([LedgerModule]);
    ledger = moduleRef.get(LedgerService);
    dataSource = moduleRef.get(DataSource);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    clearing = await ledger.ensureSystemAccount({
      code: 'system:psp-clearing:NGN',
      name: 'PSP clearing (NGN)',
      type: LedgerAccountType.Asset,
      currency: 'NGN',
      allowNegativeBalance: true,
    });
    alice = await ledger.createAccount({
      name: 'Alice',
      type: LedgerAccountType.Liability,
      currency: 'NGN',
    });
    bob = await ledger.createAccount({
      name: 'Bob',
      type: LedgerAccountType.Liability,
      currency: 'NGN',
    });
  });

  afterEach(async () => {
    // Invariants that must hold after every scenario, successful or not.
    await expect(ledger.findBalanceDiscrepancies()).resolves.toEqual([]);
    const trial = await ledger.trialBalance('NGN');
    expect(trial.debit).toBe(trial.credit);
  });

  afterAll(() => moduleRef.close());

  describe('posting', () => {
    it('applies balanced entries on each account’s normal side', async () => {
      const result = await deposit(alice, 1_000_000n, 'dep-1');

      expect(result).toMatchObject({ replayed: false });
      await expect(balanceOf(alice)).resolves.toBe(1_000_000n);
      await expect(balanceOf(clearing)).resolves.toBe(1_000_000n);
    });

    it('moves money between customers', async () => {
      await deposit(alice, 1_000_000n, 'dep-1');
      await ledger.post(transfer(alice, bob, 250_000n, 'tr-1'));

      await expect(balanceOf(alice)).resolves.toBe(750_000n);
      await expect(balanceOf(bob)).resolves.toBe(250_000n);
    });

    it('rejects an overdraft and leaves no trace', async () => {
      await deposit(alice, 100n, 'dep-1');

      await expect(
        ledger.post(transfer(alice, bob, 101n, 'tr-1')),
      ).rejects.toThrow(InsufficientFundsException);
      await expect(balanceOf(alice)).resolves.toBe(100n);
      await expect(
        dataSource.query(
          `SELECT 1 FROM ledger_transactions WHERE reference = 'tr-1'`,
        ),
      ).resolves.toHaveLength(0);
    });

    it('rejects accounts in another currency', async () => {
      const usd = await ledger.createAccount({
        name: 'USD',
        type: LedgerAccountType.Liability,
        currency: 'USD',
      });

      await expect(
        ledger.post(transfer(clearing, usd, 100n, 'fx-1')),
      ).rejects.toThrow(CurrencyMismatchException);
    });
  });

  describe('idempotency', () => {
    it('replays an identical posting without a second effect', async () => {
      const first = await ledger.post(transfer(clearing, alice, 500n, 'dep-1'));
      const second = await ledger.post(
        transfer(clearing, alice, 500n, 'dep-1'),
      );

      expect(second).toMatchObject({ replayed: true });
      expect(second.transaction.id).toBe(first.transaction.id);
      await expect(balanceOf(alice)).resolves.toBe(500n);
    });

    it('rejects a different posting that reuses a reference', async () => {
      await ledger.post(transfer(clearing, alice, 500n, 'dep-1'));

      await expect(
        ledger.post(transfer(clearing, alice, 501n, 'dep-1')),
      ).rejects.toThrow(LedgerReferenceConflictException);
    });

    it('applies concurrent duplicates exactly once', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          ledger.post(transfer(clearing, alice, 700n, 'dep-1')),
        ),
      );

      expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      await expect(balanceOf(alice)).resolves.toBe(700n);
    });
  });

  describe('reversal', () => {
    it('restores balances and links to the original', async () => {
      const original = await deposit(alice, 1_000n, 'dep-1');
      const { transactionId } = {
        transactionId: (original as { transaction: { id: string } }).transaction
          .id,
      };

      const reversal = await ledger.reverse(transactionId, {
        reference: 'rev-1',
        description: 'Reverse',
      });

      expect(reversal.transaction.reversalOfId).toBe(transactionId);
      await expect(balanceOf(alice)).resolves.toBe(0n);
      await expect(balanceOf(clearing)).resolves.toBe(0n);
    });

    it('replays a reversal retried with the same reference', async () => {
      const { transaction } = await ledger.post(
        transfer(clearing, alice, 1_000n, 'dep-1'),
      );
      const first = await ledger.reverse(transaction.id, {
        reference: 'rev-1',
        description: 'Reverse',
      });
      const retry = await ledger.reverse(transaction.id, {
        reference: 'rev-1',
        description: 'Reverse',
      });

      expect(retry).toMatchObject({ replayed: true });
      expect(retry.transaction.id).toBe(first.transaction.id);
    });

    it('can reverse a transaction only once', async () => {
      const { transaction } = await ledger.post(
        transfer(clearing, alice, 1_000n, 'dep-1'),
      );
      await ledger.reverse(transaction.id, {
        reference: 'rev-1',
        description: 'Reverse',
      });

      await expect(
        ledger.reverse(transaction.id, {
          reference: 'rev-2',
          description: 'Again',
        }),
      ).rejects.toThrow(TransactionAlreadyReversedException);
    });

    it('cannot reverse into an overdraft', async () => {
      const { transaction } = await ledger.post(
        transfer(clearing, alice, 1_000n, 'dep-1'),
      );
      await ledger.post(transfer(alice, bob, 600n, 'tr-1'));

      await expect(
        ledger.reverse(transaction.id, {
          reference: 'rev-1',
          description: 'Reverse',
        }),
      ).rejects.toThrow(InsufficientFundsException);
    });
  });

  describe('concurrency', () => {
    it('allows only one of two simultaneous ₦7,000 withdrawals from ₦10,000', async () => {
      await deposit(alice, 1_000_000n, 'dep-1'); // ₦10,000.00

      const withdraw = (reference: string): Promise<unknown> =>
        ledger.post(transfer(alice, clearing, 700_000n, reference)); // ₦7,000.00

      const results = await Promise.allSettled([
        withdraw('wd-1'),
        withdraw('wd-2'),
      ]);

      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(InsufficientFundsException);
      await expect(balanceOf(alice)).resolves.toBe(300_000n);
    });

    it('never overdraws under many concurrent withdrawals', async () => {
      await deposit(alice, 1_000_000n, 'dep-1');

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          ledger.post(transfer(alice, clearing, 70_000n, `wd-${i}`)),
        ),
      );

      // ₦10,000 / ₦700 = 14 withdrawals fit; the rest must fail cleanly.
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(14);
      await expect(balanceOf(alice)).resolves.toBe(20_000n);
    });

    it('does not deadlock on opposing transfers (locks taken in id order)', async () => {
      await deposit(alice, 1_000_000n, 'dep-a');
      await deposit(bob, 1_000_000n, 'dep-b');

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 === 0
            ? ledger.post(transfer(alice, bob, 1_000n, `ab-${i}`))
            : ledger.post(transfer(bob, alice, 1_000n, `ba-${i}`)),
        ),
      );

      await expect(balanceOf(alice)).resolves.toBe(1_000_000n);
      await expect(balanceOf(bob)).resolves.toBe(1_000_000n);
    });
  });

  describe('database guarantees (bypassing the service)', () => {
    const insertTransaction = (reference: string, amount: number): string =>
      `INSERT INTO ledger_transactions (reference, description, currency, amount)
       VALUES ('${reference}', 'raw', 'NGN', ${amount}) RETURNING id`;

    it('rejects direct balance updates', async () => {
      await expect(
        dataSource.query(
          `UPDATE ledger_accounts SET balance = 1000000 WHERE id = $1`,
          [alice.id],
        ),
      ).rejects.toThrow(/can only change by posting ledger entries/);
    });

    it('rejects accounts created with a balance', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO ledger_accounts (name, type, normal_balance, currency, balance)
           VALUES ('x', 'liability', 'credit', 'NGN', 500)`,
        ),
      ).rejects.toThrow(/zero balance/);
    });

    it('rejects updates and deletes of ledger history', async () => {
      await deposit(alice, 1_000n, 'dep-1');

      await expect(
        dataSource.query(`UPDATE ledger_entries SET amount = 1`),
      ).rejects.toThrow(/immutable/);
      await expect(
        dataSource.query(`DELETE FROM ledger_entries`),
      ).rejects.toThrow(/immutable/);
      await expect(
        dataSource.query(`UPDATE ledger_transactions SET amount = 1`),
      ).rejects.toThrow(/immutable/);
      await expect(
        dataSource.query(`DELETE FROM ledger_transactions`),
      ).rejects.toThrow(/immutable/);
    });

    it('rejects an unbalanced transaction at commit', async () => {
      await expect(
        dataSource.transaction(async (manager) => {
          const [txn] = await manager.query<{ id: string }[]>(
            insertTransaction('raw-1', 100),
          );
          await manager.query(
            `INSERT INTO ledger_entries (ledger_transaction_id, ledger_account_id, direction, amount, currency)
             VALUES ($1, $2, 'debit', 100, 'NGN'), ($1, $3, 'credit', 90, 'NGN')`,
            [txn?.id, clearing.id, alice.id],
          );
        }),
      ).rejects.toThrow(/unbalanced/);

      await expect(balanceOf(alice)).resolves.toBe(0n);
    });

    it('rejects a transaction with no entries at commit', async () => {
      await expect(
        dataSource.transaction((manager) =>
          manager.query(insertTransaction('raw-2', 100)),
        ),
      ).rejects.toThrow(/unbalanced/);
    });

    it('rejects an overdraft even without the application check', async () => {
      await expect(
        dataSource.transaction(async (manager) => {
          const [txn] = await manager.query<{ id: string }[]>(
            insertTransaction('raw-3', 100),
          );
          await manager.query(
            `INSERT INTO ledger_entries (ledger_transaction_id, ledger_account_id, direction, amount, currency)
             VALUES ($1, $2, 'debit', 100, 'NGN'), ($1, $3, 'credit', 100, 'NGN')`,
            [txn?.id, alice.id, bob.id],
          );
        }),
      ).rejects.toThrow(/chk_ledger_accounts_non_negative/);
    });

    it('rejects entries whose currency differs from their account', async () => {
      await expect(
        dataSource.transaction(async (manager) => {
          const [txn] = await manager.query<{ id: string }[]>(
            `INSERT INTO ledger_transactions (reference, description, currency, amount)
             VALUES ('raw-4', 'raw', 'USD', 100) RETURNING id`,
          );
          await manager.query(
            `INSERT INTO ledger_entries (ledger_transaction_id, ledger_account_id, direction, amount, currency)
             VALUES ($1, $2, 'debit', 100, 'USD'), ($1, $3, 'credit', 100, 'USD')`,
            [txn?.id, clearing.id, alice.id],
          );
        }),
      ).rejects.toThrow(/does not match account/);
    });
  });
});
