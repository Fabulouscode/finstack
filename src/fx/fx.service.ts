import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { CurrencyCode } from '../common/money/currency';
import { fxConfig } from '../config/fx.config';
import type { FxConfig } from '../config/fx.config';
import { LedgerTransaction } from '../ledger/ledger-transaction.entity';
import { LedgerService } from '../ledger/ledger.service';
import { EntryDirection, LedgerAccountType } from '../ledger/ledger.types';
import { FxQuote } from './fx-quote.entity';
import {
  convertFromSource,
  convertToTarget,
  Conversion,
  parseRate,
} from './fx-math';
import {
  ConversionAmountTooSmallException,
  FxQuoteAlreadyUsedException,
  FxQuoteExpiredException,
  FxQuoteNotFoundException,
  FxRateStaleException,
  FxRateUnavailableException,
  SameCurrencyConversionException,
} from './fx.errors';
import { FX_RATE_PROVIDER } from './rate-provider';
import type { RateProvider } from './rate-provider';

export type QuoteAmount =
  | { sourceAmount: bigint; targetAmount?: undefined }
  | { targetAmount: bigint; sourceAmount?: undefined };

export type CreateQuoteInput = {
  userId: string | null;
  sourceCurrency: CurrencyCode;
  targetCurrency: CurrencyCode;
} & QuoteAmount;

export interface ConvertInput {
  quoteId: string;
  /** Idempotency reference of the conversion (e.g. the payment reference). */
  reference: string;
  description: string;
  /** Account the source currency comes from (e.g. PSP clearing in NGN). */
  sourceDebitAccountId: string;
  /** Account credited in the target currency (e.g. a USD wallet). */
  targetCreditAccountId: string;
  /** When set, the quote must belong to this user. */
  userId?: string | null;
  /** Runs inside the conversion's database transaction (e.g. wallet checks). */
  beforeConvert?: (manager: EntityManager) => Promise<void>;
}

export interface ConversionResult {
  quote: FxQuote;
  sourceLeg: LedgerTransaction;
  targetLeg: LedgerTransaction;
  replayed: boolean;
}

const { Debit, Credit } = EntryDirection;

@Injectable()
export class FxService {
  constructor(
    @InjectRepository(FxQuote)
    private readonly quotes: Repository<FxQuote>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(FX_RATE_PROVIDER)
    private readonly rates: RateProvider,
    private readonly ledger: LedgerService,
    @Inject(fxConfig.KEY)
    private readonly config: FxConfig,
  ) {}

  /** Locks a rate for FX_QUOTE_TTL_SECONDS. */
  async createQuote(input: CreateQuoteInput): Promise<FxQuote> {
    const { sourceCurrency: source, targetCurrency: target } = input;
    if (source === target) {
      throw new SameCurrencyConversionException();
    }

    const snapshot = await this.rates.getRate(source, target);
    if (!snapshot) {
      throw new FxRateUnavailableException(source, target);
    }
    if (Date.now() - snapshot.asOf.getTime() > this.config.rateMaxAgeMs) {
      throw new FxRateStaleException(source, target);
    }

    const rate = {
      base: snapshot.base,
      quote: snapshot.quote,
      scaled: parseRate(snapshot.rate),
    };
    const conversion: Conversion =
      input.sourceAmount !== undefined
        ? convertFromSource(
            rate,
            source,
            target,
            input.sourceAmount,
            this.config.spreadBps,
          )
        : convertToTarget(
            rate,
            source,
            target,
            input.targetAmount,
            this.config.spreadBps,
          );

    if (conversion.targetAmount <= 0n) {
      throw new ConversionAmountTooSmallException();
    }

    return this.quotes.save(
      this.quotes.create({
        userId: input.userId,
        fxRateId: snapshot.rateId,
        sourceCurrency: source,
        targetCurrency: target,
        sourceAmount: conversion.sourceAmount,
        targetAmount: conversion.targetAmount,
        grossTargetAmount: conversion.grossTargetAmount,
        spreadBps: this.config.spreadBps,
        rateBaseCurrency: snapshot.base,
        rateQuoteCurrency: snapshot.quote,
        rate: snapshot.rate,
        expiresAt: new Date(Date.now() + this.config.quoteTtlMs),
        consumedAt: null,
        conversionReference: null,
        sourceTransactionId: null,
        targetTransactionId: null,
      }),
    );
  }

  /** Own quotes only; other users' quotes read as not found. */
  async getQuote(quoteId: string, userId?: string | null): Promise<FxQuote> {
    const quote = await this.quotes.findOneBy({ id: quoteId });
    if (!quote || (userId !== undefined && quote.userId !== userId)) {
      throw new FxQuoteNotFoundException();
    }
    return quote;
  }

  /**
   * Executes a quote as two single-currency ledger postings, atomically:
   *
   *   source leg: Dr sourceDebitAccount   S | Cr FX position (source) S
   *   target leg: Dr FX position (target) G | Cr targetCreditAccount  T
   *                                         | Cr FX revenue (target)  G - T
   *
   * The quote row is locked FOR UPDATE, so a quote is consumed exactly once
   * even under concurrent attempts. Retrying with the same reference returns
   * the original result.
   */
  convert(input: ConvertInput): Promise<ConversionResult> {
    return this.dataSource.transaction((manager) =>
      this.convertWithin(manager, input),
    );
  }

  /**
   * Same as convert(), inside a caller-owned database transaction, so the
   * conversion commits atomically with the caller's records (e.g. a payment
   * settlement).
   */
  async convertWithin(
    manager: EntityManager,
    input: ConvertInput,
  ): Promise<ConversionResult> {
    const preview = await this.getQuote(input.quoteId, input.userId);
    const accounts = await this.systemAccounts(
      preview.sourceCurrency,
      preview.targetCurrency,
    );

    await input.beforeConvert?.(manager);

    const quote = await manager
      .createQueryBuilder(FxQuote, 'quote')
      .setLock('pessimistic_write')
      .where('quote.id = :id', { id: input.quoteId })
      .getOneOrFail();

    if (quote.consumedAt !== null) {
      if (quote.conversionReference === input.reference) {
        return this.replay(manager, quote);
      }
      throw new FxQuoteAlreadyUsedException();
    }
    if (quote.expiresAt.getTime() <= Date.now()) {
      throw new FxQuoteExpiredException();
    }

    const sourceLeg = await this.ledger.postWithin(manager, {
      reference: `${input.reference}:fx-source`,
      description: `${input.description} (${quote.sourceCurrency} leg)`,
      currency: quote.sourceCurrency,
      metadata: { fxQuoteId: quote.id },
      entries: [
        {
          accountId: input.sourceDebitAccountId,
          direction: Debit,
          amount: quote.sourceAmount,
        },
        {
          accountId: accounts.sourcePosition,
          direction: Credit,
          amount: quote.sourceAmount,
        },
      ],
    });

    const spread = quote.grossTargetAmount - quote.targetAmount;
    const targetLeg = await this.ledger.postWithin(manager, {
      reference: `${input.reference}:fx-target`,
      description: `${input.description} (${quote.targetCurrency} leg)`,
      currency: quote.targetCurrency,
      metadata: {
        fxQuoteId: quote.id,
        rate: quote.rate,
        spreadBps: quote.spreadBps,
      },
      entries: [
        {
          accountId: accounts.targetPosition,
          direction: Debit,
          amount: quote.grossTargetAmount,
        },
        {
          accountId: input.targetCreditAccountId,
          direction: Credit,
          amount: quote.targetAmount,
        },
        ...(spread > 0n
          ? [
              {
                accountId: accounts.targetRevenue,
                direction: Credit,
                amount: spread,
              },
            ]
          : []),
      ],
    });

    await manager.update(FxQuote, quote.id, {
      consumedAt: new Date(),
      conversionReference: input.reference,
      sourceTransactionId: sourceLeg.transaction.id,
      targetTransactionId: targetLeg.transaction.id,
    });

    return {
      quote: await manager.findOneByOrFail(FxQuote, { id: quote.id }),
      sourceLeg: sourceLeg.transaction,
      targetLeg: targetLeg.transaction,
      replayed: false,
    };
  }

  private async replay(
    manager: EntityManager,
    quote: FxQuote,
  ): Promise<ConversionResult> {
    const [sourceLeg, targetLeg] = await Promise.all([
      manager.findOneByOrFail(LedgerTransaction, {
        id: quote.sourceTransactionId ?? '',
      }),
      manager.findOneByOrFail(LedgerTransaction, {
        id: quote.targetTransactionId ?? '',
      }),
    ]);
    return { quote, sourceLeg, targetLeg, replayed: true };
  }

  /**
   * FX position accounts hold each currency's side of conversions: after
   * converting ₦15,500 into $10, the NGN position shows the naira taken in and
   * the USD position the dollars owed out. Together they are the platform's
   * open FX exposure.
   */
  private async systemAccounts(
    source: string,
    target: string,
  ): Promise<{
    sourcePosition: string;
    targetPosition: string;
    targetRevenue: string;
  }> {
    const position = (currency: string): Promise<{ id: string }> =>
      this.ledger.ensureSystemAccount({
        code: `system:fx-position:${currency}`,
        name: `FX position (${currency})`,
        type: LedgerAccountType.Asset,
        currency,
        allowNegativeBalance: true,
      });

    const [sourcePosition, targetPosition, targetRevenue] = await Promise.all([
      position(source),
      position(target),
      this.ledger.ensureSystemAccount({
        code: `system:fx-revenue:${target}`,
        name: `FX revenue (${target})`,
        type: LedgerAccountType.Revenue,
        currency: target,
      }),
    ]);

    return {
      sourcePosition: sourcePosition.id,
      targetPosition: targetPosition.id,
      targetRevenue: targetRevenue.id,
    };
  }
}
