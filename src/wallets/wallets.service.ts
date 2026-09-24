import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { CurrencyCode } from '../common/money/currency';
import { isUniqueViolation } from '../database/postgres-errors';
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
  ) {}

  /** Creates the wallet and its three ledger accounts atomically. */
  async create(
    userId: string,
    currency: CurrencyCode,
  ): Promise<WalletWithBalances> {
    try {
      const wallet = await this.dataSource.transaction(async (manager) => {
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
            availableAccountId: available.id,
            pendingAccountId: pending.id,
            reservedAccountId: reserved.id,
          }),
        );
      });

      return { wallet, balances: { available: 0n, pending: 0n, reserved: 0n } };
    } catch (error) {
      if (isUniqueViolation(error, 'uq_wallets_user_currency')) {
        throw new WalletAlreadyExistsException(currency);
      }
      throw error;
    }
  }

  async listForUser(userId: string): Promise<WalletWithBalances[]> {
    const wallets = await this.wallets.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return this.withBalances(wallets);
  }

  async getForUser(
    userId: string,
    walletId: string,
  ): Promise<WalletWithBalances> {
    const wallet = await this.findOwned(userId, walletId);
    const [result] = await this.withBalances([wallet]);
    if (!result) {
      throw new WalletNotFoundException();
    }
    return result;
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

  private async findOwned(userId: string, walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findOneBy({ id: walletId, userId });
    if (!wallet) {
      throw new WalletNotFoundException();
    }
    return wallet;
  }

  /** Loads all balances in a single query. */
  private async withBalances(wallets: Wallet[]): Promise<WalletWithBalances[]> {
    if (wallets.length === 0) return [];

    const accountIds = wallets.flatMap((w) => [
      w.availableAccountId,
      w.pendingAccountId,
      w.reservedAccountId,
    ]);
    const accounts = await this.dataSource.manager.findBy(LedgerAccount, {
      id: In(accountIds),
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
