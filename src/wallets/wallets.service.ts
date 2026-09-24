import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { CurrencyCode } from '../common/money/currency';
import { walletsConfig, WalletsPerOwner } from '../config/wallets.config';
import type { WalletsConfig } from '../config/wallets.config';
import { isUniqueViolation } from '../database/postgres-errors';
import { ConversionResult, FxService } from '../fx/fx.service';
import { LedgerAccount } from '../ledger/ledger-account.entity';
import { CurrencyMismatchException } from '../ledger/ledger.errors';
import {
  EntryCursor,
  EntryPage,
  LedgerService,
  PostedTransaction,
} from '../ledger/ledger.service';
import { EntryDirection, LedgerAccountType } from '../ledger/ledger.types';
import { Wallet, WalletStatus } from './wallet.entity';
import {
  WalletAlreadyExistsException,
  WalletCurrencyNotAllowedException,
  WalletNotActiveException,
  WalletNotFoundException,
} from './wallets.errors';

export interface WalletBalances {
  available: bigint;
  pending: bigint;
  reserved: bigint;
}

export interface WalletWithBalances {
  wallet: Wallet;
  balances: WalletBalances;
}

export interface CreditTarget {
  wallet: Wallet;
  /** True when the money must be converted into the (primary) wallet's currency. */
  requiresConversion: boolean;
}

export interface MoneyMovement {
  /** Minor units, strictly positive. */
  amount: bigint;
  /** Idempotency reference: the same reference never moves money twice. */
  reference: string;
  description: string;
  metadata?: Record<string, unknown>;
}

const { Debit, Credit } = EntryDirection;

@Injectable()
export class WalletsService {
  constructor(
    @InjectRepository(Wallet)
    private readonly wallets: Repository<Wallet>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    @Inject(walletsConfig.KEY)
    private readonly config: WalletsConfig,
    private readonly fx: FxService,
  ) {}

  /**
   * Opens a wallet and its three ledger accounts atomically.
   *
   * - `single` mode: one wallet per user, always primary. The partial unique
   *   index on the primary flag makes this hold under concurrent requests.
   * - `multiple` mode: one wallet per allowed currency. The first wallet
   *   becomes primary; losing a race to be primary retries as non-primary.
   */
  async create(
    userId: string,
    currency: CurrencyCode = this.config.defaultCurrency,
  ): Promise<WalletWithBalances> {
    if (!this.config.allowedCurrencies.includes(currency)) {
      throw new WalletCurrencyNotAllowedException(
        this.config.allowedCurrencies,
      );
    }
    const single = this.config.walletsPerOwner === WalletsPerOwner.Single;
    const alreadyExists = (): WalletAlreadyExistsException =>
      single
        ? new WalletAlreadyExistsException()
        : new WalletAlreadyExistsException(
            `A ${currency} wallet already exists`,
          );

    try {
      return await this.insertWallet(
        userId,
        currency,
        single ? true : 'if-first',
      );
    } catch (error) {
      if (isUniqueViolation(error, 'uq_wallets_user_currency')) {
        throw alreadyExists();
      }
      if (isUniqueViolation(error, 'uq_wallets_user_primary')) {
        if (single) {
          throw alreadyExists();
        }
        // A concurrent request created the first (primary) wallet.
        return this.insertWallet(userId, currency, false).catch(
          (retryError: unknown) => {
            if (isUniqueViolation(retryError, 'uq_wallets_user_currency')) {
              throw alreadyExists();
            }
            throw retryError;
          },
        );
      }
      throw error;
    }
  }

  /** Primary wallet first, then by age. */
  async listForUser(userId: string): Promise<WalletWithBalances[]> {
    const wallets = await this.wallets.find({
      where: { userId },
      order: { isPrimary: 'DESC', createdAt: 'ASC' },
    });
    return this.withBalances(wallets);
  }

  async getPrimary(userId: string): Promise<WalletWithBalances> {
    const wallet = await this.wallets.findOneBy({ userId, isPrimary: true });
    if (!wallet) {
      throw new WalletNotFoundException();
    }
    return this.withBalance(wallet);
  }

  async getForUser(
    userId: string,
    walletId: string,
  ): Promise<WalletWithBalances> {
    return this.withBalance(await this.findOwned(userId, walletId));
  }

  /** Makes another active wallet the one that receives converted payments. */
  async setPrimary(
    userId: string,
    walletId: string,
  ): Promise<WalletWithBalances> {
    await this.dataSource.transaction(async (manager) => {
      // Lock the user's wallets so concurrent switches serialise.
      const wallets = await manager
        .createQueryBuilder(Wallet, 'wallet')
        .where('wallet.userId = :userId', { userId })
        .orderBy('wallet.id')
        .setLock('pessimistic_write')
        .getMany();

      const target = wallets.find((wallet) => wallet.id === walletId);
      if (!target) {
        throw new WalletNotFoundException();
      }
      if (target.isPrimary) {
        return;
      }
      if (target.status !== WalletStatus.Active) {
        throw new WalletNotActiveException();
      }
      // Clear first: the partial unique index allows only one primary.
      await manager.update(
        Wallet,
        { userId, isPrimary: true },
        { isPrimary: false },
      );
      await manager.update(Wallet, { id: walletId }, { isPrimary: true });
    });

    return this.getForUser(userId, walletId);
  }

  /**
   * Where incoming money in `currency` should land (the crediting rule):
   * the user's wallet in that currency if there is one, otherwise the
   * primary wallet, which then requires an FX conversion.
   */
  async resolveCreditTarget(
    userId: string,
    currency: string,
  ): Promise<CreditTarget> {
    const wallets = await this.wallets.findBy({ userId });

    const exact = wallets.find((wallet) => wallet.currency === currency);
    if (exact) {
      return { wallet: exact, requiresConversion: false };
    }
    const primary = wallets.find((wallet) => wallet.isPrimary);
    if (!primary) {
      throw new WalletNotFoundException();
    }
    return { wallet: primary, requiresConversion: true };
  }

  async listEntriesForUser(
    userId: string,
    walletId: string,
    options: { limit: number; before?: EntryCursor },
  ): Promise<EntryPage> {
    const wallet = await this.findOwned(userId, walletId);
    return this.ledger.listAccountEntries(wallet.availableAccountId, options);
  }

  // ---- Money movement ---------------------------------------------------------
  // Service-level API used by payments, transfers and tests. HTTP endpoints
  // that move money are added with the idempotency layer.

  /** External funds in: external clearing (asset) -> wallet available. */
  async deposit(
    walletId: string,
    movement: MoneyMovement,
  ): Promise<PostedTransaction> {
    const wallet = await this.getWallet(walletId);
    const clearing = await this.clearingAccount(wallet.currency);

    return this.post([walletId], wallet.currency, movement, [
      { accountId: clearing.id, direction: Debit, amount: movement.amount },
      {
        accountId: wallet.availableAccountId,
        direction: Credit,
        amount: movement.amount,
      },
    ]);
  }

  /**
   * External funds in a foreign currency, converted into the wallet's
   * currency at a locked FX quote (e.g. ₦15,500 paid -> $9.90 credited).
   * Idempotent by reference; the quote is consumed exactly once.
   */
  async depositWithConversion(
    walletId: string,
    input: { quoteId: string; reference: string; description: string },
  ): Promise<ConversionResult> {
    const wallet = await this.getWallet(walletId);
    const quote = await this.fx.getQuote(input.quoteId);
    if (quote.targetCurrency !== wallet.currency) {
      throw new CurrencyMismatchException(
        `The quote converts into ${quote.targetCurrency}, but the wallet holds ${wallet.currency}`,
      );
    }
    const clearing = await this.clearingAccount(quote.sourceCurrency);

    return this.fx.convert({
      quoteId: input.quoteId,
      reference: input.reference,
      description: input.description,
      sourceDebitAccountId: clearing.id,
      targetCreditAccountId: wallet.availableAccountId,
      beforeConvert: (manager) => this.lockActiveWallets(manager, [walletId]),
    });
  }

  /**
   * Converts between two of the user's own wallets at a quote the user
   * obtained (e.g. NGN wallet -> USD wallet). Idempotent by reference.
   */
  async convertBetweenWallets(
    userId: string,
    input: {
      fromWalletId: string;
      toWalletId: string;
      quoteId: string;
      reference: string;
      description: string;
    },
  ): Promise<ConversionResult> {
    const [from, to] = await Promise.all([
      this.findOwned(userId, input.fromWalletId),
      this.findOwned(userId, input.toWalletId),
    ]);
    const quote = await this.fx.getQuote(input.quoteId, userId);
    if (
      quote.sourceCurrency !== from.currency ||
      quote.targetCurrency !== to.currency
    ) {
      throw new CurrencyMismatchException(
        `The quote converts ${quote.sourceCurrency} to ${quote.targetCurrency}, but the wallets hold ${from.currency} and ${to.currency}`,
      );
    }

    return this.fx.convert({
      quoteId: quote.id,
      userId,
      reference: input.reference,
      description: input.description,
      sourceDebitAccountId: from.availableAccountId,
      targetCreditAccountId: to.availableAccountId,
      beforeConvert: (manager) =>
        this.lockActiveWallets(manager, [from.id, to.id]),
    });
  }

  /** Funds out to an external destination: wallet available -> external clearing. */
  async withdraw(
    walletId: string,
    movement: MoneyMovement,
  ): Promise<PostedTransaction> {
    const wallet = await this.getWallet(walletId);
    const clearing = await this.clearingAccount(wallet.currency);

    return this.post([walletId], wallet.currency, movement, [
      {
        accountId: wallet.availableAccountId,
        direction: Debit,
        amount: movement.amount,
      },
      { accountId: clearing.id, direction: Credit, amount: movement.amount },
    ]);
  }

  /** Wallet to wallet in the same currency. */
  async transfer(
    fromWalletId: string,
    toWalletId: string,
    movement: MoneyMovement,
  ): Promise<PostedTransaction> {
    const [from, to] = await Promise.all([
      this.getWallet(fromWalletId),
      this.getWallet(toWalletId),
    ]);
    if (from.currency !== to.currency) {
      throw new CurrencyMismatchException(
        'Both wallets must use the same currency',
      );
    }

    return this.post([fromWalletId, toWalletId], from.currency, movement, [
      {
        accountId: from.availableAccountId,
        direction: Debit,
        amount: movement.amount,
      },
      {
        accountId: to.availableAccountId,
        direction: Credit,
        amount: movement.amount,
      },
    ]);
  }

  /** Puts funds on hold: available -> reserved. */
  async reserve(
    walletId: string,
    movement: MoneyMovement,
  ): Promise<PostedTransaction> {
    const wallet = await this.getWallet(walletId);
    return this.post([walletId], wallet.currency, movement, [
      {
        accountId: wallet.availableAccountId,
        direction: Debit,
        amount: movement.amount,
      },
      {
        accountId: wallet.reservedAccountId,
        direction: Credit,
        amount: movement.amount,
      },
    ]);
  }

  /** Releases a hold: reserved -> available. */
  async release(
    walletId: string,
    movement: MoneyMovement,
  ): Promise<PostedTransaction> {
    const wallet = await this.getWallet(walletId);
    return this.post([walletId], wallet.currency, movement, [
      {
        accountId: wallet.reservedAccountId,
        direction: Debit,
        amount: movement.amount,
      },
      {
        accountId: wallet.availableAccountId,
        direction: Credit,
        amount: movement.amount,
      },
    ]);
  }

  async setStatus(walletId: string, status: WalletStatus): Promise<void> {
    await this.wallets.update({ id: walletId }, { status });
  }

  // ---- Internals --------------------------------------------------------------

  private post(
    walletIds: string[],
    currency: string,
    movement: MoneyMovement,
    entries: { accountId: string; direction: EntryDirection; amount: bigint }[],
  ): Promise<PostedTransaction> {
    return this.ledger.post(
      {
        reference: movement.reference,
        description: movement.description,
        currency,
        metadata: { ...movement.metadata, walletIds },
        entries,
      },
      { beforePost: (manager) => this.lockActiveWallets(manager, walletIds) },
    );
  }

  /**
   * FOR SHARE blocks a concurrent status change (freeze) until the posting
   * commits, and vice versa, without serialising postings to each other.
   */
  private async lockActiveWallets(
    manager: EntityManager,
    walletIds: string[],
  ): Promise<void> {
    const wallets = await manager
      .createQueryBuilder(Wallet, 'wallet')
      .where('wallet.id IN (:...ids)', { ids: [...new Set(walletIds)].sort() })
      .orderBy('wallet.id')
      .setLock('pessimistic_read')
      .getMany();

    if (wallets.some((wallet) => wallet.status !== WalletStatus.Active)) {
      throw new WalletNotActiveException();
    }
  }

  private clearingAccount(currency: string): Promise<LedgerAccount> {
    return this.ledger.ensureSystemAccount({
      code: `system:external-clearing:${currency}`,
      name: `External clearing (${currency})`,
      type: LedgerAccountType.Asset,
      currency,
      // Mirrors money held at payment providers/banks; may go negative
      // while settlements are in flight.
      allowNegativeBalance: true,
    });
  }

  private async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findOneBy({ id: walletId });
    if (!wallet) {
      throw new WalletNotFoundException();
    }
    return wallet;
  }

  private async insertWallet(
    userId: string,
    currency: CurrencyCode,
    primary: boolean | 'if-first',
  ): Promise<WalletWithBalances> {
    const wallet = await this.dataSource.transaction(async (manager) => {
      const isPrimary =
        primary === 'if-first'
          ? !(await manager.existsBy(Wallet, { userId, isPrimary: true }))
          : primary;

      const account = (purpose: string): Promise<LedgerAccount> =>
        this.ledger.createAccount(
          {
            name: `Wallet ${purpose} (${currency})`,
            type: LedgerAccountType.Liability,
            currency,
          },
          manager,
        );
      const [available, pending, reserved] = await Promise.all([
        account('available'),
        account('pending'),
        account('reserved'),
      ]);

      return manager.save(
        manager.create(Wallet, {
          userId,
          currency,
          status: WalletStatus.Active,
          isPrimary,
          availableAccountId: available.id,
          pendingAccountId: pending.id,
          reservedAccountId: reserved.id,
        }),
      );
    });

    return { wallet, balances: { available: 0n, pending: 0n, reserved: 0n } };
  }

  private async findOwned(userId: string, walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findOneBy({ id: walletId, userId });
    if (!wallet) {
      throw new WalletNotFoundException();
    }
    return wallet;
  }

  private async withBalance(wallet: Wallet): Promise<WalletWithBalances> {
    const [result] = await this.withBalances([wallet]);
    if (!result) {
      throw new WalletNotFoundException();
    }
    return result;
  }

  /** Loads all balances of all given wallets in a single query. */
  private async withBalances(wallets: Wallet[]): Promise<WalletWithBalances[]> {
    if (wallets.length === 0) return [];

    const accounts = await this.dataSource.manager.findBy(LedgerAccount, {
      id: In(
        wallets.flatMap((w) => [
          w.availableAccountId,
          w.pendingAccountId,
          w.reservedAccountId,
        ]),
      ),
    });
    const balance = new Map(accounts.map((a) => [a.id, a.balance]));

    return wallets.map((wallet) => ({
      wallet,
      balances: {
        available: balance.get(wallet.availableAccountId) ?? 0n,
        pending: balance.get(wallet.pendingAccountId) ?? 0n,
        reserved: balance.get(wallet.reservedAccountId) ?? 0n,
      },
    }));
  }
}
