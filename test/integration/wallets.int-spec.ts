import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  CurrencyMismatchException,
  InsufficientFundsException,
} from '../../src/ledger/ledger.errors';
import { LedgerService } from '../../src/ledger/ledger.service';
import { UsersModule } from '../../src/users/users.module';
import { UsersService } from '../../src/users/users.service';
import { WalletStatus } from '../../src/wallets/wallet.entity';
import {
  WalletAlreadyExistsException,
  WalletNotActiveException,
  WalletNotFoundException,
} from '../../src/wallets/wallets.errors';
import { WalletsModule } from '../../src/wallets/wallets.module';
import {
  MoneyMovement,
  WalletBalances,
  WalletsService,
} from '../../src/wallets/wallets.service';
import { createTestModule } from '../utils/create-test-module';
import { resetDatabase } from '../utils/database';

describe('WalletsService (integration)', () => {
  let moduleRef: TestingModule;
  let wallets: WalletsService;
  let ledger: LedgerService;
  let dataSource: DataSource;
  let aliceId: string;
  let bobId: string;

  const createUser = async (email: string): Promise<string> =>
    (
      await moduleRef.get(UsersService).create({
        email,
        passwordHash: 'x',
        firstName: 'Test',
        lastName: 'User',
      })
    ).id;

  const movement = (amount: bigint, reference: string): MoneyMovement => ({
    amount,
    reference,
    description: reference,
  });

  const balances = async (
    userId: string,
    walletId: string,
  ): Promise<WalletBalances> =>
    (await wallets.getForUser(userId, walletId)).balances;

  beforeAll(async () => {
    moduleRef = await createTestModule([UsersModule, WalletsModule]);
    wallets = moduleRef.get(WalletsService);
    ledger = moduleRef.get(LedgerService);
    dataSource = moduleRef.get(DataSource);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    aliceId = await createUser('alice@example.com');
    bobId = await createUser('bob@example.com');
  });

  afterEach(async () => {
    await expect(ledger.findBalanceDiscrepancies()).resolves.toEqual([]);
  });

  afterAll(() => moduleRef.close());

  describe('opening wallets', () => {
    it('creates a wallet with three zero-balance ledger accounts', async () => {
      const { wallet, balances } = await wallets.create(aliceId, 'NGN');

      expect(wallet).toMatchObject({
        userId: aliceId,
        currency: 'NGN',
        status: 'active',
      });
      expect(balances).toEqual({ available: 0n, pending: 0n, reserved: 0n });
      const accounts = await ledger.getAccounts([
        wallet.availableAccountId,
        wallet.pendingAccountId,
        wallet.reservedAccountId,
      ]);
      expect(accounts).toHaveLength(3);
      accounts.forEach((account) =>
        expect(account).toMatchObject({
          type: 'liability',
          currency: 'NGN',
          allowNegativeBalance: false,
        }),
      );
    });

    it('defaults the base currency to USD', async () => {
      const { wallet } = await wallets.create(aliceId);

      expect(wallet.currency).toBe('USD');
      await expect(wallets.getMine(aliceId)).resolves.toMatchObject({
        wallet: { id: wallet.id },
      });
    });

    it('allows exactly one wallet per user, whatever the currency', async () => {
      await wallets.create(aliceId, 'NGN');
      await wallets.create(bobId, 'NGN');

      await expect(wallets.create(aliceId, 'NGN')).rejects.toThrow(
        WalletAlreadyExistsException,
      );
      await expect(wallets.create(aliceId, 'USD')).rejects.toThrow(
        WalletAlreadyExistsException,
      );
    });

    it('resolves concurrent duplicate creation with one winner and no orphan accounts', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => wallets.create(aliceId, 'NGN')),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [row] = await dataSource.query<{ count: string }[]>(
        'SELECT count(*) FROM ledger_accounts',
      );
      expect(Number(row?.count)).toBe(3);
    });

    it('hides wallets owned by other users', async () => {
      const { wallet } = await wallets.create(aliceId, 'NGN');

      await expect(wallets.getForUser(bobId, wallet.id)).rejects.toThrow(
        WalletNotFoundException,
      );
      await expect(wallets.getMine(bobId)).rejects.toThrow(
        WalletNotFoundException,
      );
    });
  });

  describe('moving money', () => {
    let aliceWallet: string;
    let bobWallet: string;

    beforeEach(async () => {
      aliceWallet = (await wallets.create(aliceId, 'NGN')).wallet.id;
      bobWallet = (await wallets.create(bobId, 'NGN')).wallet.id;
    });

    it('deposits, transfers and withdraws through the ledger', async () => {
      await wallets.deposit(aliceWallet, movement(1_000_000n, 'dep-1'));
      await wallets.transfer(
        aliceWallet,
        bobWallet,
        movement(400_000n, 'tr-1'),
      );
      await wallets.withdraw(bobWallet, movement(150_000n, 'wd-1'));

      await expect(balances(aliceId, aliceWallet)).resolves.toMatchObject({
        available: 600_000n,
      });
      await expect(balances(bobId, bobWallet)).resolves.toMatchObject({
        available: 250_000n,
      });
    });

    it('does not apply a retried movement twice', async () => {
      await wallets.deposit(aliceWallet, movement(1_000_000n, 'dep-1'));
      await wallets.deposit(aliceWallet, movement(1_000_000n, 'dep-1'));

      await expect(balances(aliceId, aliceWallet)).resolves.toMatchObject({
        available: 1_000_000n,
      });
    });

    it('reserves and releases funds without changing the total', async () => {
      await wallets.deposit(aliceWallet, movement(1_000_000n, 'dep-1'));
      await wallets.reserve(aliceWallet, movement(300_000n, 'hold-1'));

      await expect(balances(aliceId, aliceWallet)).resolves.toEqual({
        available: 700_000n,
        pending: 0n,
        reserved: 300_000n,
      });
      await expect(
        wallets.withdraw(aliceWallet, movement(800_000n, 'wd-1')),
      ).rejects.toThrow(InsufficientFundsException);

      await wallets.release(aliceWallet, movement(300_000n, 'release-1'));
      await expect(balances(aliceId, aliceWallet)).resolves.toMatchObject({
        available: 1_000_000n,
        reserved: 0n,
      });
    });

    it('allows only one of two simultaneous ₦7,000 withdrawals from ₦10,000', async () => {
      await wallets.deposit(aliceWallet, movement(1_000_000n, 'dep-1'));

      const results = await Promise.allSettled([
        wallets.withdraw(aliceWallet, movement(700_000n, 'wd-1')),
        wallets.withdraw(aliceWallet, movement(700_000n, 'wd-2')),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(rejected?.reason).toBeInstanceOf(InsufficientFundsException);
      await expect(balances(aliceId, aliceWallet)).resolves.toMatchObject({
        available: 300_000n,
      });
    });

    it('blocks movements on a frozen wallet, in both directions', async () => {
      await wallets.deposit(aliceWallet, movement(1_000_000n, 'dep-1'));
      await wallets.setStatus(bobWallet, WalletStatus.Frozen);

      await expect(
        wallets.transfer(aliceWallet, bobWallet, movement(1n, 'tr-1')),
      ).rejects.toThrow(WalletNotActiveException);
      await expect(
        wallets.deposit(bobWallet, movement(1n, 'dep-2')),
      ).rejects.toThrow(WalletNotActiveException);
      await expect(balances(aliceId, aliceWallet)).resolves.toMatchObject({
        available: 1_000_000n,
      });
    });

    it('rejects transfers between wallets with different base currencies', async () => {
      const carolId = await createUser('carol@example.com');
      const usd = (await wallets.create(carolId, 'USD')).wallet.id;
      await wallets.deposit(aliceWallet, movement(1_000n, 'dep-1'));

      await expect(
        wallets.transfer(aliceWallet, usd, movement(1_000n, 'tr-1')),
      ).rejects.toThrow(CurrencyMismatchException);
    });
  });

  describe('entry history', () => {
    it('pages through entries newest first without gaps or duplicates', async () => {
      const { wallet } = await wallets.create(aliceId, 'NGN');
      for (let i = 1; i <= 7; i++) {
        await wallets.deposit(wallet.id, movement(BigInt(i * 100), `dep-${i}`));
      }

      const seen: string[] = [];
      let before;
      for (let page = 0; page < 10; page++) {
        const result = await wallets.listEntriesForUser(aliceId, wallet.id, {
          limit: 3,
          before,
        });
        seen.push(...result.entries.map((e) => e.reference));
        if (!result.next) break;
        before = result.next;
      }

      expect(seen).toEqual([
        'dep-7',
        'dep-6',
        'dep-5',
        'dep-4',
        'dep-3',
        'dep-2',
        'dep-1',
      ]);
    });
  });
});
