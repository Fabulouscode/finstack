import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { CurrencyCode } from '../common/money/currency';
import { walletsConfig, WalletsPerOwner } from '../config/wallets.config';
import type { WalletsConfig } from '../config/wallets.config';
import {
  OwnerRef,
  ownerColumns,
  ownerUserId,
  ownerWhere,
} from '../common/owner/owner';
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
import { SystemAccounts } from '../ledger/system-accounts';
import { Wallet, WalletStatus } from './wallet.entity';
import {
  WalletAlreadyExistsException,
  WalletCurrencyNotAllowedException,
  WalletNotActiveException,
  WalletNotFoundException,
} from './wallets.errors';

const CURRENCY_CONSTRAINTS = [
  'uq_wallets_user_currency',
  'uq_wallets_org_currency',
];
const PRIMARY_CONSTRAINTS = [
  'uq_wallets_user_primary',
  'uq_wallets_org_primary',
];

/** Which balance a deposit lands in. */
export type DepositBalance = 'available' | 'pending';

function balanceAccount(wallet: Wallet, balance: DepositBalance): string {
  return balance === 'pending'
    ? wallet.pendingAccountId
    : wallet.availableAccountId;
}

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
    private readonly audit: AuditService,
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
    owner: OwnerRef,
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
        owner,
        currency,
        single ? true : 'if-first',
      );
    } catch (error) {
      if (isUniqueViolation(error, CURRENCY_CONSTRAINTS)) {
        throw alreadyExists();
      }
      if (isUniqueViolation(error, PRIMARY_CONSTRAINTS)) {
        if (single) {
          throw alreadyExists();
        }
        // A concurrent request created the first (primary) wallet.
        return this.insertWallet(owner, currency, false).catch(
          (retryError: unknown) => {
            if (isUniqueViolation(retryError, CURRENCY_CONSTRAINTS)) {
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
  async listFor(owner: OwnerRef): Promise<WalletWithBalances[]> {
    const wallets = await this.wallets.find({
      where: ownerWhere(owner),
      order: { isPrimary: 'DESC', createdAt: 'ASC' },
    });
    return this.withBalances(wallets);
  }

  async getPrimary(owner: OwnerRef): Promise<WalletWithBalances> {
    const wallet = await this.wallets.findOneBy({
      ...ownerWhere(owner),
      isPrimary: true,
    });
    if (!wallet) {
      throw new WalletNotFoundException();
    }
    return this.withBalance(wallet);
  }

  async getOwned(
    owner: OwnerRef,
    walletId: string,
  ): Promise<WalletWithBalances> {
    return this.withBalance(await this.findOwned(owner, walletId));
  }

  /** Makes another active wallet the one that receives converted payments. */
  async setPrimary(
    owner: OwnerRef,
    walletId: string,
  ): Promise<WalletWithBalances> {
    await this.dataSource.transaction(async (manager) => {
      // Lock the user's wallets so concurrent switches serialise.
      const wallets = await manager
        .createQueryBuilder(Wallet, 'wallet')
        .where(ownerWhere(owner))
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
        { ...ownerWhere(owner), isPrimary: true },
        { isPrimary: false },
      );
      await manager.update(Wallet, { id: walletId }, { isPrimary: true });
      await this.audit.record(manager, {
        action: AuditAction.WalletPrimaryChanged,
        organizationId: target.organizationId,
        targetType: 'wallet',
        targetId: walletId,
        metadata: {
          previousPrimaryWalletId:
            wallets.find((wallet) => wallet.isPrimary)?.id ?? null,
        },
      });
    });

    return this.getOwned(owner, walletId);
  }

  /**
   * Where incoming money in `currency` should land (the crediting rule):
   * the user's wallet in that currency if there is one, otherwise the
   * primary wallet, which then requires an FX conversion.
   */
  async resolveCreditTarget(
    owner: OwnerRef,
    currency: string,
  ): Promise<CreditTarget> {
    const wallets = await this.wallets.findBy(ownerWhere(owner));

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

  findWallet(owner: OwnerRef, currency: string): Promise<Wallet | null> {
    return this.wallets.findOneBy({ ...ownerWhere(owner), currency });
  }

  findPrimaryWallet(owner: OwnerRef): Promise<Wallet | null> {
    return this.wallets.findOneBy({ ...ownerWhere(owner), isPrimary: true });
  }

  async listEntries(
    owner: OwnerRef,
    walletId: string,
    options: { limit: number; before?: EntryCursor },
  ): Promise<EntryPage> {
    const wallet = await this.findOwned(owner, walletId);
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
    const { wallet, clearing } = await this.prepareConversionDeposit(
      walletId,
      input.quoteId,
    );

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
    owner: OwnerRef,
    input: {
      fromWalletId: string;
      toWalletId: string;
      quoteId: string;
      reference: string;
      description: string;
    },
  ): Promise<ConversionResult> {
    const [from, to] = await Promise.all([
      this.findOwned(owner, input.fromWalletId),
      this.findOwned(owner, input.toWalletId),
    ]);
    const quote = await this.fx.getQuote(input.quoteId, ownerUserId(owner));
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
      userId: ownerUserId(owner),
      reference: input.reference,
      description: input.description,
      sourceDebitAccountId: from.availableAccountId,
      targetCreditAccountId: to.availableAccountId,
      beforeConvert: (manager) =>
        this.lockActiveWallets(manager, [from.id, to.id]),
    });
  }

  /**
   * deposit() inside a caller-owned database transaction, so the credit
   * commits atomically with the caller's records (e.g. payment settlement).
   */
  async depositWithin(
    manager: EntityManager,
    walletId: string,
    movement: MoneyMovement,
    into: DepositBalance = 'available',
  ): Promise<PostedTransaction> {
    const wallet = await this.getWallet(walletId);
    const clearing = await this.clearingAccount(wallet.currency);
    await this.lockActiveWallets(manager, [walletId]);

    return this.ledger.postWithin(manager, {
      reference: movement.reference,
      description: movement.description,
      currency: wallet.currency,
      metadata: { ...movement.metadata, walletIds: [walletId] },
      entries: [
        { accountId: clearing.id, direction: Debit, amount: movement.amount },
        {
          accountId: balanceAccount(wallet, into),
          direction: Credit,
          amount: movement.amount,
        },
      ],
    });
  }

  /** depositWithConversion() inside a caller-owned database transaction. */
  async depositWithConversionWithin(
    manager: EntityManager,
    walletId: string,
    input: { quoteId: string; reference: string; description: string },
    into: DepositBalance = 'available',
  ): Promise<ConversionResult> {
    const { wallet, clearing } = await this.prepareConversionDeposit(
      walletId,
      input.quoteId,
    );

    return this.fx.convertWithin(manager, {
      quoteId: input.quoteId,
      reference: input.reference,
      description: input.description,
      sourceDebitAccountId: clearing.id,
      targetCreditAccountId: balanceAccount(wallet, into),
      beforeConvert: (m) => this.lockActiveWallets(m, [walletId]),
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

  /**
   * Wallet-to-wallet movement inside a caller-owned database transaction, so
   * it commits atomically with the caller's own records (e.g. a transfer).
   */
  async transferWithin(
    manager: EntityManager,
    from: Wallet,
    to: Wallet,
    movement: MoneyMovement,
  ): Promise<PostedTransaction> {
    if (from.currency !== to.currency) {
      throw new CurrencyMismatchException(
        'Both wallets must use the same currency',
      );
    }
    await this.lockActiveWallets(manager, [from.id, to.id]);

    return this.ledger.postWithin(manager, {
      reference: movement.reference,
      description: movement.description,
      currency: from.currency,
      metadata: { ...movement.metadata, walletIds: [from.id, to.id] },
      entries: [
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
      ],
    });
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

  /** reserve() inside a caller-owned database transaction (requires an active wallet). */
  async reserveWithin(
    manager: EntityManager,
    walletId: string,
    movement: MoneyMovement,
  ): Promise<PostedTransaction> {
    await this.lockActiveWallets(manager, [walletId]);
    const wallet = await this.getWallet(walletId);
    return this.ledger.postWithin(manager, {
      reference: movement.reference,
      description: movement.description,
      currency: wallet.currency,
      metadata: { ...movement.metadata, walletIds: [walletId] },
      entries: [
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
      ],
    });
  }

  /**
   * release() inside a caller-owned database transaction. Works on frozen
   * wallets too: returning held funds must never be blocked.
   */
  async releaseWithin(
    manager: EntityManager,
    walletId: string,
    movement: MoneyMovement,
  ): Promise<PostedTransaction> {
    const wallet = await this.getWallet(walletId);
    return this.ledger.postWithin(manager, {
      reference: movement.reference,
      description: movement.description,
      currency: wallet.currency,
      metadata: { ...movement.metadata, walletIds: [walletId] },
      entries: [
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
      ],
    });
  }

  /**
   * Settlement: pending -> available, e.g. when a payment's hold period
   * ends. Works on frozen wallets too (the money stays in the wallet).
   */
  async makeAvailableWithin(
    manager: EntityManager,
    walletId: string,
    movement: MoneyMovement,
  ): Promise<PostedTransaction> {
    const wallet = await this.getWallet(walletId);
    return this.ledger.postWithin(manager, {
      reference: movement.reference,
      description: movement.description,
      currency: wallet.currency,
      metadata: { ...movement.metadata, walletIds: [walletId] },
      entries: [
        {
          accountId: wallet.pendingAccountId,
          direction: Debit,
          amount: movement.amount,
        },
        {
          accountId: wallet.availableAccountId,
          direction: Credit,
          amount: movement.amount,
        },
      ],
    });
  }

  /**
   * A hold funded from pending and available balances: `fromPending` of the
   * amount comes out of pending (e.g. refunding a payment still in its
   * settlement hold), the rest out of available.
   */
  async reserveSplitWithin(
    manager: EntityManager,
    walletId: string,
    movement: MoneyMovement & { fromPending: bigint },
  ): Promise<PostedTransaction> {
    await this.lockActiveWallets(manager, [walletId]);
    const wallet = await this.getWallet(walletId);
    return this.ledger.postWithin(manager, {
      reference: movement.reference,
      description: movement.description,
      currency: wallet.currency,
      metadata: { ...movement.metadata, walletIds: [walletId] },
      entries: this.splitEntries(wallet, movement, Debit),
    });
  }

  /** Undoes reserveSplitWithin(): each part returns where it came from. */
  async releaseSplitWithin(
    manager: EntityManager,
    walletId: string,
    movement: MoneyMovement & { fromPending: bigint },
  ): Promise<PostedTransaction> {
    const wallet = await this.getWallet(walletId);
    return this.ledger.postWithin(manager, {
      reference: movement.reference,
      description: movement.description,
      currency: wallet.currency,
      metadata: { ...movement.metadata, walletIds: [walletId] },
      entries: this.splitEntries(wallet, movement, Credit),
    });
  }

  /** Entries between pending/available and reserved; `side` applies to the sources. */
  private splitEntries(
    wallet: Wallet,
    movement: MoneyMovement & { fromPending: bigint },
    side: EntryDirection,
  ): { accountId: string; direction: EntryDirection; amount: bigint }[] {
    const opposite = side === Debit ? Credit : Debit;
    const fromAvailable = movement.amount - movement.fromPending;
    return [
      ...(movement.fromPending > 0n
        ? [
            {
              accountId: wallet.pendingAccountId,
              direction: side,
              amount: movement.fromPending,
            },
          ]
        : []),
      ...(fromAvailable > 0n
        ? [
            {
              accountId: wallet.availableAccountId,
              direction: side,
              amount: fromAvailable,
            },
          ]
        : []),
      {
        accountId: wallet.reservedAccountId,
        direction: opposite,
        amount: movement.amount,
      },
    ];
  }

  /**
   * Collects a fee from one of the wallet's balances into fee revenue,
   * inside the caller's transaction (e.g. with the payment credit it
   * applies to). Fails if the balance can't cover it.
   */
  async collectFeeWithin(
    manager: EntityManager,
    walletId: string,
    from: 'available' | 'pending' | 'reserved',
    movement: MoneyMovement,
  ): Promise<PostedTransaction> {
    const wallet = await this.getWallet(walletId);
    const revenue = await this.ledger.ensureSystemAccount(
      SystemAccounts.feeRevenue(wallet.currency),
    );
    const accountId =
      from === 'pending'
        ? wallet.pendingAccountId
        : from === 'reserved'
          ? wallet.reservedAccountId
          : wallet.availableAccountId;
    return this.ledger.postWithin(manager, {
      reference: movement.reference,
      description: movement.description,
      currency: wallet.currency,
      metadata: { ...movement.metadata, walletIds: [walletId] },
      entries: [
        { accountId, direction: Debit, amount: movement.amount },
        { accountId: revenue.id, direction: Credit, amount: movement.amount },
      ],
    });
  }

  /** Gives a collected fee back to the wallet's available balance. */
  async refundFeeWithin(
    manager: EntityManager,
    walletId: string,
    movement: MoneyMovement,
  ): Promise<PostedTransaction> {
    const wallet = await this.getWallet(walletId);
    const revenue = await this.ledger.ensureSystemAccount(
      SystemAccounts.feeRevenue(wallet.currency),
    );
    return this.ledger.postWithin(manager, {
      reference: movement.reference,
      description: movement.description,
      currency: wallet.currency,
      metadata: { ...movement.metadata, walletIds: [walletId] },
      entries: [
        { accountId: revenue.id, direction: Debit, amount: movement.amount },
        {
          accountId: wallet.availableAccountId,
          direction: Credit,
          amount: movement.amount,
        },
      ],
    });
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

  /** Frozen wallets can't send money; held funds can still be released. */
  async setStatus(
    walletId: string,
    status: WalletStatus,
    manager?: EntityManager,
  ): Promise<void> {
    await (manager ?? this.wallets.manager).update(
      Wallet,
      { id: walletId },
      { status },
    );
  }

  /** A wallet with balances, by id; no ownership check (admin use). */
  async getWithBalances(walletId: string): Promise<WalletWithBalances> {
    return this.withBalance(await this.getWallet(walletId));
  }

  /** What FinStack owes its wallet holders, per currency and balance. */
  async balanceTotals(): Promise<
    Record<string, { available: bigint; pending: bigint; reserved: bigint }>
  > {
    const [available, pending, reserved] = await Promise.all(
      (['available', 'pending', 'reserved'] as const).map((balance) =>
        this.ledger.sumBalancesByCurrency(
          `SELECT ${balance}_account_id FROM wallets`,
        ),
      ),
    );
    const totals: Record<
      string,
      { available: bigint; pending: bigint; reserved: bigint }
    > = {};
    for (const currency of new Set([
      ...Object.keys(available ?? {}),
      ...Object.keys(pending ?? {}),
      ...Object.keys(reserved ?? {}),
    ])) {
      totals[currency] = {
        available: available?.[currency] ?? 0n,
        pending: pending?.[currency] ?? 0n,
        reserved: reserved?.[currency] ?? 0n,
      };
    }
    return totals;
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
    return this.ledger.ensureSystemAccount(
      SystemAccounts.externalClearing(currency),
    );
  }

  /** A wallet by id (e.g. to post to its accounts); no ownership check. */
  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findOneBy({ id: walletId });
    if (!wallet) {
      throw new WalletNotFoundException();
    }
    return wallet;
  }

  private async insertWallet(
    owner: OwnerRef,
    currency: CurrencyCode,
    primary: boolean | 'if-first',
  ): Promise<WalletWithBalances> {
    const wallet = await this.dataSource.transaction(async (manager) => {
      const isPrimary =
        primary === 'if-first'
          ? !(await manager.existsBy(Wallet, {
              ...ownerWhere(owner),
              isPrimary: true,
            }))
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
      // Sequential on purpose: queries on one transaction's connection must
      // not run concurrently (pg queues them today and will reject them in v9).
      const available = await account('available');
      const pending = await account('pending');
      const reserved = await account('reserved');

      const created = await manager.save(
        manager.create(Wallet, {
          ...ownerColumns(owner),
          currency,
          status: WalletStatus.Active,
          isPrimary,
          availableAccountId: available.id,
          pendingAccountId: pending.id,
          reservedAccountId: reserved.id,
        }),
      );
      await this.audit.record(manager, {
        action: AuditAction.WalletCreated,
        organizationId: created.organizationId,
        targetType: 'wallet',
        targetId: created.id,
        metadata: { currency, isPrimary },
      });
      return created;
    });

    return { wallet, balances: { available: 0n, pending: 0n, reserved: 0n } };
  }

  private async prepareConversionDeposit(
    walletId: string,
    quoteId: string,
  ): Promise<{ wallet: Wallet; clearing: LedgerAccount }> {
    const wallet = await this.getWallet(walletId);
    const quote = await this.fx.getQuote(quoteId);
    if (quote.targetCurrency !== wallet.currency) {
      throw new CurrencyMismatchException(
        `The quote converts into ${quote.targetCurrency}, but the wallet holds ${wallet.currency}`,
      );
    }
    return {
      wallet,
      clearing: await this.clearingAccount(quote.sourceCurrency),
    };
  }

  private async findOwned(owner: OwnerRef, walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findOneBy({
      id: walletId,
      ...ownerWhere(owner),
    });
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

    const accounts = await this.ledger.getAccounts(
      wallets.flatMap((w) => [
        w.availableAccountId,
        w.pendingAccountId,
        w.reservedAccountId,
      ]),
    );
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
