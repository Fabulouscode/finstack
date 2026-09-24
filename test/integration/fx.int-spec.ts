import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AdminRateProvider } from '../../src/fx/admin-rate.provider';
import {
  FxQuoteAlreadyUsedException,
  FxQuoteExpiredException,
  FxRateStaleException,
  FxRateUnavailableException,
  SameCurrencyConversionException,
  ConversionAmountTooSmallException,
} from '../../src/fx/fx.errors';
import { FxQuote } from '../../src/fx/fx-quote.entity';
import { FxService } from '../../src/fx/fx.service';
import { LedgerAccount } from '../../src/ledger/ledger-account.entity';
import { CurrencyMismatchException } from '../../src/ledger/ledger.errors';
import { LedgerService } from '../../src/ledger/ledger.service';
import { UsersModule } from '../../src/users/users.module';
import { UsersService } from '../../src/users/users.service';
import { WalletStatus } from '../../src/wallets/wallet.entity';
import { WalletNotActiveException } from '../../src/wallets/wallets.errors';
import { WalletsModule } from '../../src/wallets/wallets.module';
import { WalletsService } from '../../src/wallets/wallets.service';
import { createTestModule } from '../utils/create-test-module';
import { resetDatabase } from '../utils/database';

describe('FX (integration)', () => {
  let moduleRef: TestingModule;
  let fx: FxService;
  let rates: AdminRateProvider;
  let wallets: WalletsService;
  let ledger: LedgerService;
  let dataSource: DataSource;
  let userId: string;
  let walletId: string;

  const systemBalance = async (code: string): Promise<bigint> =>
    (await dataSource.manager.findOneByOrFail(LedgerAccount, { code })).balance;

  const walletBalance = async (): Promise<bigint> =>
    (await wallets.getMine(userId)).balances.available;

  /** ₦15,500.00 -> $10.00 gross, $9.90 after the 1% spread. */
  const quoteNairaToDollars = (): Promise<FxQuote> =>
    fx.createQuote({
      userId,
      sourceCurrency: 'NGN',
      targetCurrency: 'USD',
      sourceAmount: 1_550_000n,
    });

  beforeAll(async () => {
    moduleRef = await createTestModule([UsersModule, WalletsModule]);
    fx = moduleRef.get(FxService);
    rates = moduleRef.get(AdminRateProvider);
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
    walletId = (await wallets.create(userId, 'USD')).wallet.id;
    await rates.setRate({
      base: 'USD',
      quote: 'NGN',
      rate: '1550',
      userId: null,
    });
  });

  afterEach(async () => {
    await expect(ledger.findBalanceDiscrepancies()).resolves.toEqual([]);
    for (const currency of ['NGN', 'USD']) {
      const trial = await ledger.trialBalance(currency);
      expect(trial.debit).toBe(trial.credit);
    }
  });

  afterAll(() => moduleRef.close());

  describe('quotes', () => {
    it('locks the rate, spread and amounts', async () => {
      const quote = await quoteNairaToDollars();

      expect(quote).toMatchObject({
        sourceCurrency: 'NGN',
        targetCurrency: 'USD',
        sourceAmount: 1_550_000n,
        grossTargetAmount: 1_000n,
        targetAmount: 990n,
        spreadBps: 100,
        rateBaseCurrency: 'USD',
        rateQuoteCurrency: 'NGN',
      });
      expect(quote.expiresAt.getTime() - Date.now()).toBeGreaterThan(890_000);
    });

    it('quotes the naira to charge for a dollar amount, rounded up', async () => {
      const quote = await fx.createQuote({
        userId,
        sourceCurrency: 'NGN',
        targetCurrency: 'USD',
        targetAmount: 1_000n,
      });

      expect(quote.targetAmount).toBeGreaterThanOrEqual(1_000n);
      expect(quote.sourceAmount).toBe(1_565_657n); // ₦15,656.57
    });

    it('uses the newest rate, in either orientation', async () => {
      await rates.setRate({
        base: 'NGN',
        quote: 'USD',
        rate: '0.0005',
        userId: null,
      }); // 2000 NGN/USD

      const quote = await quoteNairaToDollars();
      expect(quote.grossTargetAmount).toBe(775n); // ₦15,500 / 2000
    });

    it('refuses pairs without a rate, same-currency and dust amounts', async () => {
      await expect(
        fx.createQuote({
          userId,
          sourceCurrency: 'EUR',
          targetCurrency: 'USD',
          sourceAmount: 100n,
        }),
      ).rejects.toThrow(FxRateUnavailableException);
      await expect(
        fx.createQuote({
          userId,
          sourceCurrency: 'USD',
          targetCurrency: 'USD',
          sourceAmount: 100n,
        }),
      ).rejects.toThrow(SameCurrencyConversionException);
      await expect(
        fx.createQuote({
          userId,
          sourceCurrency: 'NGN',
          targetCurrency: 'USD',
          sourceAmount: 100n,
        }),
      ).rejects.toThrow(ConversionAmountTooSmallException);
    });

    it('refuses to quote on a stale rate', async () => {
      await dataSource.query(
        `UPDATE fx_rates SET created_at = now() - interval '2 days'`,
      );

      await expect(quoteNairaToDollars()).rejects.toThrow(FxRateStaleException);
    });
  });

  describe('converting a naira deposit into a dollar wallet', () => {
    it('credits the quoted dollars and books both legs and the spread', async () => {
      const quote = await quoteNairaToDollars();

      const result = await wallets.depositWithConversion(walletId, {
        quoteId: quote.id,
        reference: 'pay-1',
        description: 'Card payment',
      });

      expect(result.replayed).toBe(false);
      await expect(walletBalance()).resolves.toBe(990n); // $9.90
      await expect(systemBalance('system:external-clearing:NGN')).resolves.toBe(
        1_550_000n,
      );
      await expect(systemBalance('system:fx-position:NGN')).resolves.toBe(
        -1_550_000n,
      );
      await expect(systemBalance('system:fx-position:USD')).resolves.toBe(
        1_000n,
      );
      await expect(systemBalance('system:fx-revenue:USD')).resolves.toBe(10n); // $0.10

      const used = await dataSource.manager.findOneByOrFail(FxQuote, {
        id: quote.id,
      });
      expect(used).toMatchObject({
        conversionReference: 'pay-1',
        sourceTransactionId: result.sourceLeg.id,
        targetTransactionId: result.targetLeg.id,
      });
    });

    it('replays a retried conversion without crediting twice', async () => {
      const quote = await quoteNairaToDollars();
      const input = {
        quoteId: quote.id,
        reference: 'pay-1',
        description: 'Card payment',
      };

      const first = await wallets.depositWithConversion(walletId, input);
      const retry = await wallets.depositWithConversion(walletId, input);

      expect(retry.replayed).toBe(true);
      expect(retry.targetLeg.id).toBe(first.targetLeg.id);
      await expect(walletBalance()).resolves.toBe(990n);
    });

    it('never uses a quote for two different conversions', async () => {
      const quote = await quoteNairaToDollars();
      await wallets.depositWithConversion(walletId, {
        quoteId: quote.id,
        reference: 'pay-1',
        description: 'Card payment',
      });

      await expect(
        wallets.depositWithConversion(walletId, {
          quoteId: quote.id,
          reference: 'pay-2',
          description: 'Card payment',
        }),
      ).rejects.toThrow(FxQuoteAlreadyUsedException);
    });

    it('consumes a quote exactly once under concurrent attempts', async () => {
      const quote = await quoteNairaToDollars();

      const results = await Promise.allSettled(
        ['pay-1', 'pay-2', 'pay-3'].map((reference) =>
          wallets.depositWithConversion(walletId, {
            quoteId: quote.id,
            reference,
            description: 'Card payment',
          }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      await expect(walletBalance()).resolves.toBe(990n);
    });

    it('rejects an expired quote and moves nothing', async () => {
      const quote = await quoteNairaToDollars();
      await dataSource.query(
        `UPDATE fx_quotes SET expires_at = now() - interval '1 second'`,
      );

      await expect(
        wallets.depositWithConversion(walletId, {
          quoteId: quote.id,
          reference: 'pay-1',
          description: 'Card payment',
        }),
      ).rejects.toThrow(FxQuoteExpiredException);
      await expect(walletBalance()).resolves.toBe(0n);
    });

    it('rejects a quote into another currency than the wallet holds', async () => {
      await rates.setRate({
        base: 'EUR',
        quote: 'NGN',
        rate: '1700',
        userId: null,
      });
      const quote = await fx.createQuote({
        userId,
        sourceCurrency: 'NGN',
        targetCurrency: 'EUR',
        sourceAmount: 1_700_000n,
      });

      await expect(
        wallets.depositWithConversion(walletId, {
          quoteId: quote.id,
          reference: 'pay-1',
          description: 'Card payment',
        }),
      ).rejects.toThrow(CurrencyMismatchException);
    });

    it('leaves the quote unused when the wallet is frozen', async () => {
      const quote = await quoteNairaToDollars();
      await wallets.setStatus(walletId, WalletStatus.Frozen);

      await expect(
        wallets.depositWithConversion(walletId, {
          quoteId: quote.id,
          reference: 'pay-1',
          description: 'Card payment',
        }),
      ).rejects.toThrow(WalletNotActiveException);

      const unused = await dataSource.manager.findOneByOrFail(FxQuote, {
        id: quote.id,
      });
      expect(unused.consumedAt).toBeNull();
    });
  });
});
