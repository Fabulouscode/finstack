import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { InsufficientFundsException } from '../../src/ledger/ledger.errors';
import { LedgerService } from '../../src/ledger/ledger.service';
import { Transaction } from '../../src/transactions/transaction.entity';
import {
  canTransition,
  TransactionStatus,
  TransactionType,
} from '../../src/transactions/transaction.types';
import { TransactionsModule } from '../../src/transactions/transactions.module';
import { TransactionsService } from '../../src/transactions/transactions.service';
import {
  NoWalletInCurrencyException,
  RecipientCannotReceiveException,
  RecipientNotFoundException,
  SelfTransferException,
  TransfersService,
} from '../../src/transactions/transfers.service';
import { UsersService } from '../../src/users/users.service';
import { WalletStatus } from '../../src/wallets/wallet.entity';
import { WalletNotActiveException } from '../../src/wallets/wallets.errors';
import { WalletsService } from '../../src/wallets/wallets.service';
import { createTestModule } from '../utils/create-test-module';
import { resetDatabase } from '../utils/database';

describe('Transactions (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let transfers: TransfersService;
  let transactions: TransactionsService;
  let wallets: WalletsService;
  let ledger: LedgerService;
  let aliceId: string;
  let bobId: string;
  let aliceWallet: string;
  let bobWallet: string;

  const createUser = async (email: string): Promise<string> =>
    (
      await moduleRef
        .get(UsersService)
        .create({ email, passwordHash: 'x', firstName: 'T', lastName: 'U' })
    ).id;

  const available = async (userId: string, walletId: string): Promise<bigint> =>
    (await wallets.getOwned(userId, walletId)).balances.available;

  beforeAll(async () => {
    moduleRef = await createTestModule([TransactionsModule]);
    dataSource = moduleRef.get(DataSource);
    transfers = moduleRef.get(TransfersService);
    transactions = moduleRef.get(TransactionsService);
    wallets = moduleRef.get(WalletsService);
    ledger = moduleRef.get(LedgerService);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    aliceId = await createUser('alice@example.com');
    bobId = await createUser('bob@example.com');
    aliceWallet = (await wallets.create(aliceId, 'USD')).wallet.id;
    bobWallet = (await wallets.create(bobId, 'USD')).wallet.id;
    await wallets.deposit(aliceWallet, {
      amount: 10_000n,
      reference: 'dep-1',
      description: 'Top-up',
    });
  });

  afterEach(async () => {
    await expect(ledger.findBalanceDiscrepancies()).resolves.toEqual([]);
  });

  afterAll(() => moduleRef.close());

  describe('status transitions: code and database agree on every pair', () => {
    const statuses = Object.values(TransactionStatus);
    const pairs = statuses.flatMap((from) =>
      statuses
        .filter((to) => to !== from)
        .map((to): [TransactionStatus, TransactionStatus] => [from, to]),
    );

    it.each(pairs)('%s -> %s', async (from, to) => {
      // Seed a row directly in the source status (inserts are unrestricted).
      // It references the deposit's ledger transaction so that successful and
      // reversed rows satisfy chk_transactions_successful_has_ledger.
      const [ledgerTxn] = await dataSource.query<{ id: string }[]>(
        `SELECT id FROM ledger_transactions LIMIT 1`,
      );
      const [row] = await dataSource.query<{ id: string }[]>(
        `INSERT INTO transactions (reference, type, status, user_id, amount, currency, ledger_transaction_id)
         VALUES ('trx_' || md5(random()::text), 'transfer', $1, $2, 100, 'USD', $3) RETURNING id`,
        [from, aliceId, ledgerTxn?.id],
      );

      const update = dataSource.query(
        `UPDATE transactions SET status = $1 WHERE id = $2`,
        [to, row?.id],
      );

      if (canTransition(from, to)) {
        await expect(update).resolves.toBeDefined();
      } else {
        await expect(update).rejects.toThrow(
          /invalid transaction status transition/,
        );
      }
    });
  });

  describe('transfers', () => {
    it('moves money, records a successful transaction linked to the ledger', async () => {
      const txn = await transfers.transfer(
        aliceId,
        {
          recipientEmail: 'BOB@example.com',
          amount: 2_500n,
          description: 'Dinner',
        },
        'key-1',
      );

      expect(txn).toMatchObject({
        type: TransactionType.Transfer,
        status: TransactionStatus.Successful,
        userId: aliceId,
        counterpartyUserId: bobId,
        sourceWalletId: aliceWallet,
        destinationWalletId: bobWallet,
        amount: 2_500n,
        currency: 'USD',
        description: 'Dinner',
      });
      expect(txn.reference).toMatch(/^trx_[0-9a-f]{20}$/);
      expect(txn.ledgerTransactionId).not.toBeNull();
      expect(txn.completedAt).toBeInstanceOf(Date);
      await expect(available(aliceId, aliceWallet)).resolves.toBe(7_500n);
      await expect(available(bobId, bobWallet)).resolves.toBe(2_500n);
    });

    it('returns the existing transaction for a repeated idempotency key', async () => {
      const first = await transfers.transfer(
        aliceId,
        { recipientEmail: 'bob@example.com', amount: 1_000n },
        'key-1',
      );
      const again = await transfers.transfer(
        aliceId,
        { recipientEmail: 'bob@example.com', amount: 1_000n },
        'key-1',
      );

      expect(again.id).toBe(first.id);
      await expect(available(bobId, bobWallet)).resolves.toBe(1_000n);
    });

    it('executes once when the same key races past the HTTP layer', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          transfers.transfer(
            aliceId,
            { recipientEmail: 'bob@example.com', amount: 1_000n },
            'key-1',
          ),
        ),
      );

      const ids = results
        .filter(
          (r): r is PromiseFulfilledResult<Transaction> =>
            r.status === 'fulfilled',
        )
        .map((r) => r.value.id);
      expect(new Set(ids).size).toBe(1);
      await expect(available(bobId, bobWallet)).resolves.toBe(1_000n);
      await expect(dataSource.getRepository(Transaction).count()).resolves.toBe(
        1,
      );
    });

    it('leaves no transaction behind when funds are insufficient', async () => {
      await expect(
        transfers.transfer(
          aliceId,
          { recipientEmail: 'bob@example.com', amount: 10_001n },
          'key-1',
        ),
      ).rejects.toThrow(InsufficientFundsException);

      await expect(dataSource.getRepository(Transaction).count()).resolves.toBe(
        0,
      );
      await expect(available(aliceId, aliceWallet)).resolves.toBe(10_000n);
    });

    it('refuses unknown recipients, self-transfers and frozen wallets', async () => {
      await expect(
        transfers.transfer(
          aliceId,
          { recipientEmail: 'nobody@example.com', amount: 1n },
          'k1',
        ),
      ).rejects.toThrow(RecipientNotFoundException);
      await expect(
        transfers.transfer(
          aliceId,
          { recipientEmail: 'alice@example.com', amount: 1n },
          'k2',
        ),
      ).rejects.toThrow(SelfTransferException);

      await wallets.setStatus(bobWallet, WalletStatus.Frozen);
      await expect(
        transfers.transfer(
          aliceId,
          { recipientEmail: 'bob@example.com', amount: 1n },
          'k3',
        ),
      ).rejects.toThrow(WalletNotActiveException);
    });

    it('requires matching currency wallets on both sides', async () => {
      await expect(
        transfers.transfer(
          aliceId,
          { recipientEmail: 'bob@example.com', amount: 1n, currency: 'NGN' },
          'k1',
        ),
      ).rejects.toThrow(NoWalletInCurrencyException);

      const carolId = await createUser('carol@example.com');
      await wallets.create(carolId, 'NGN');
      await expect(
        transfers.transfer(
          aliceId,
          { recipientEmail: 'carol@example.com', amount: 1n },
          'k2',
        ),
      ).rejects.toThrow(RecipientCannotReceiveException);
    });

    it('lists transactions for both parties, newest first', async () => {
      await transfers.transfer(
        aliceId,
        { recipientEmail: 'bob@example.com', amount: 100n },
        'k1',
      );
      await transfers.transfer(
        aliceId,
        { recipientEmail: 'bob@example.com', amount: 200n },
        'k2',
      );

      const forAlice = await transactions.listForUser(aliceId, { limit: 10 });
      const forBob = await transactions.listForUser(bobId, { limit: 1 });

      expect(forAlice.transactions.map((t) => t.amount)).toEqual([200n, 100n]);
      expect(forBob.transactions.map((t) => t.amount)).toEqual([200n]);
      expect(forBob.next).not.toBeNull();
    });
  });
});
