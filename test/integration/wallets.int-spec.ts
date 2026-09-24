import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  CurrencyMismatchException,
  InsufficientFundsException,
} from '../../src/ledger/ledger.errors';
import { AdminRateProvider } from '../../src/fx/admin-rate.provider';
import { FxQuote } from '../../src/fx/fx-quote.entity';
import { FxService } from '../../src/fx/fx.service';
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
      await expect(wallets.getPrimary(aliceId)).resolves.toMatchObject({
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

    it('keeps one wallet per user in single mode, even for concurrent requests in different currencies', async () => {
      const results = await Promise.allSettled([
        wallets.create(aliceId, 'USD'),
        wallets.create(aliceId, 'NGN'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(rejected?.reason).toBeInstanceOf(WalletAlreadyExistsException);
      await expect(wallets.listForUser(aliceId)).resolves.toHaveLength(1);
    });

    it('makes the single wallet primary and the credit target for any currency', async () => {
      const { wallet } = await wallets.create(aliceId, 'USD');

      expect(wallet.isPrimary).toBe(true);
      await expect(
        wallets.resolveCreditTarget(aliceId, 'USD'),
      ).resolves.toMatchObject({
        wallet: { id: wallet.id },
        requiresConversion: false,
      });
      await expect(
        wallets.resolveCreditTarget(aliceId, 'NGN'),
      ).resolves.toMatchObject({
        wallet: { id: wallet.id },
        requiresConversion: true,
      });
      await expect(wallets.resolveCreditTarget(bobId, 'USD')).rejects.toThrow(
        WalletNotFoundException,
      );
    });

    it('hides wallets owned by other users', async () => {
      const { wallet } = await wallets.create(aliceId, 'NGN');

      await expect(wallets.getForUser(bobId, wallet.id)).rejects.toThrow(
        WalletNotFoundException,
      );
      await expect(wallets.getPrimary(bobId)).rejects.toThrow(
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

describe('WalletsService in multiple mode (integration)', () => {
  const originalEnv = process.env;
  let moduleRef: TestingModule;
  let wallets: WalletsService;
  let ledger: LedgerService;
  let dataSource: DataSource;
  let userId: string;

  beforeAll(async () => {
    process.env = {
      ...originalEnv,
      WALLETS_PER_OWNER: 'multiple',
      ALLOWED_WALLET_CURRENCIES: 'USD,NGN,EUR',
    };
    moduleRef = await createTestModule([UsersModule, WalletsModule]);
    wallets = moduleRef.get(WalletsService);
    ledger = moduleRef.get(LedgerService);
    dataSource = moduleRef.get(DataSource);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    userId = (
      await moduleRef.get(UsersService).create({
        email: 'ada@example.com',
        passwordHash: 'x',
        firstName: 'Ada',
        lastName: 'Lovelace',
      })
    ).id;
  });

  afterEach(async () => {
    await expect(ledger.findBalanceDiscrepancies()).resolves.toEqual([]);
  });

  afterAll(async () => {
    await moduleRef.close();
    process.env = originalEnv;
  });

  it('opens one wallet per currency; the first is primary', async () => {
    const usd = (await wallets.create(userId, 'USD')).wallet;
    const ngn = (await wallets.create(userId, 'NGN')).wallet;

    expect(usd.isPrimary).toBe(true);
    expect(ngn.isPrimary).toBe(false);
    await expect(wallets.create(userId, 'NGN')).rejects.toThrow(
      WalletAlreadyExistsException,
    );
    const listed = await wallets.listForUser(userId);
    expect(listed.map(({ wallet }) => wallet.currency)).toEqual(['USD', 'NGN']);
  });

  it('ends up with exactly one primary when the first wallets are created concurrently', async () => {
    const results = await Promise.allSettled(
      ['USD', 'NGN', 'EUR'].map((currency) =>
        wallets.create(userId, currency as 'USD' | 'NGN' | 'EUR'),
      ),
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const listed = await wallets.listForUser(userId);
    expect(listed).toHaveLength(3);
    expect(listed.filter(({ wallet }) => wallet.isPrimary)).toHaveLength(1);
  });

  it('switches the primary wallet', async () => {
    await wallets.create(userId, 'USD');
    const ngn = (await wallets.create(userId, 'NGN')).wallet;

    await wallets.setPrimary(userId, ngn.id);

    await expect(wallets.getPrimary(userId)).resolves.toMatchObject({
      wallet: { id: ngn.id },
    });
    const primaries = (await wallets.listForUser(userId)).filter(
      ({ wallet }) => wallet.isPrimary,
    );
    expect(primaries).toHaveLength(1);
  });

  it('refuses to make a frozen wallet primary', async () => {
    await wallets.create(userId, 'USD');
    const ngn = (await wallets.create(userId, 'NGN')).wallet;
    await wallets.setStatus(ngn.id, WalletStatus.Frozen);

    await expect(wallets.setPrimary(userId, ngn.id)).rejects.toThrow(
      WalletNotActiveException,
    );
  });

  it('credits the matching wallet directly, and converts only when none matches', async () => {
    const usd = (await wallets.create(userId, 'USD')).wallet;
    const ngn = (await wallets.create(userId, 'NGN')).wallet;

    await expect(
      wallets.resolveCreditTarget(userId, 'NGN'),
    ).resolves.toMatchObject({
      wallet: { id: ngn.id },
      requiresConversion: false,
    });
    await expect(
      wallets.resolveCreditTarget(userId, 'GBP'),
    ).resolves.toMatchObject({
      wallet: { id: usd.id },
      requiresConversion: true,
    });
  });

  describe('converting between my wallets', () => {
    let usdId: string;
    let ngnId: string;

    beforeEach(async () => {
      usdId = (await wallets.create(userId, 'USD')).wallet.id;
      ngnId = (await wallets.create(userId, 'NGN')).wallet.id;
      await moduleRef
        .get(AdminRateProvider)
        .setRate({ base: 'USD', quote: 'NGN', rate: '1550', userId: null });
      await wallets.deposit(ngnId, {
        amount: 2_000_000n,
        reference: 'dep-1',
        description: 'Top-up',
      });
    });

    const quote = (sourceAmount: bigint): Promise<FxQuote> =>
      moduleRef.get(FxService).createQuote({
        userId,
        sourceCurrency: 'NGN',
        targetCurrency: 'USD',
        sourceAmount,
      });

    it('moves ₦15,500 out of the NGN wallet and $9.90 into the USD wallet', async () => {
      const q = await quote(1_550_000n);

      await wallets.convertBetweenWallets(userId, {
        fromWalletId: ngnId,
        toWalletId: usdId,
        quoteId: q.id,
        reference: 'conv-1',
        description: 'Convert NGN to USD',
      });

      await expect(wallets.getForUser(userId, ngnId)).resolves.toMatchObject({
        balances: { available: 450_000n },
      });
      await expect(wallets.getForUser(userId, usdId)).resolves.toMatchObject({
        balances: { available: 990n },
      });
    });

    it('fails without side effects when the source wallet lacks funds', async () => {
      const q = await quote(5_000_000n);

      await expect(
        wallets.convertBetweenWallets(userId, {
          fromWalletId: ngnId,
          toWalletId: usdId,
          quoteId: q.id,
          reference: 'conv-1',
          description: 'Convert NGN to USD',
        }),
      ).rejects.toThrow(InsufficientFundsException);

      const unused = await dataSource.manager.findOneByOrFail(FxQuote, {
        id: q.id,
      });
      expect(unused.consumedAt).toBeNull();
    });

    it('rejects a quote whose currencies do not match the wallets', async () => {
      const q = await quote(1_550_000n);

      await expect(
        wallets.convertBetweenWallets(userId, {
          fromWalletId: usdId,
          toWalletId: ngnId,
          quoteId: q.id,
          reference: 'conv-1',
          description: 'Wrong way round',
        }),
      ).rejects.toThrow(CurrencyMismatchException);
    });
  });
});
