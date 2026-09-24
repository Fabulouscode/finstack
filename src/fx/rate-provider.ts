import { CurrencyCode } from '../common/money/currency';

export interface RateSnapshot {
  /** Identifies the persisted rate row, for traceability of quotes. */
  rateId: string;
  base: CurrencyCode;
  quote: CurrencyCode;
  /** Exact decimal string, quote units per base unit. */
  rate: string;
  /** When the rate was observed/set; used for staleness checks. */
  asOf: Date;
}

/**
 * Source of exchange rates. The default implementation serves rates set by
 * admins; an external feed (e.g. Open Exchange Rates) can implement the
 * same contract and be bound to FX_RATE_PROVIDER instead.
 */
export interface RateProvider {
  /** Latest rate for the pair in either orientation, or null if none. */
  getRate(a: CurrencyCode, b: CurrencyCode): Promise<RateSnapshot | null>;
}

export const FX_RATE_PROVIDER = Symbol('FX_RATE_PROVIDER');
