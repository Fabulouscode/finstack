import { CURRENCIES, CurrencyCode } from '../common/money/currency';

/**
 * Exact FX arithmetic on bigints. Rates never pass through floating point.
 *
 * A rate is "quote units per 1 base unit" (USD/NGN 1550.25 means
 * 1 USD = 1550.25 NGN), held as an integer scaled by 10^RATE_DECIMALS.
 */
export const RATE_DECIMALS = 10;
const RATE_SCALE = 10n ** BigInt(RATE_DECIMALS);
const BPS = 10_000n;

const RATE_PATTERN = /^(\d{1,14})(?:\.(\d{1,10}))?$/;

export class InvalidRateError extends Error {}

/** Parses a positive decimal string ("1550.25") into a scaled integer. */
export function parseRate(value: string): bigint {
  const match = RATE_PATTERN.exec(value.trim());
  if (!match) {
    throw new InvalidRateError(`Invalid rate "${value}"`);
  }
  const [, whole = '0', fraction = ''] = match;
  const scaled =
    BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(RATE_DECIMALS, '0'));
  if (scaled <= 0n) {
    throw new InvalidRateError('Rate must be greater than zero');
  }
  return scaled;
}

/** Formats a scaled rate as a decimal string without trailing zeros. */
export function formatRate(scaled: bigint): string {
  const whole = scaled / RATE_SCALE;
  const fraction = (scaled % RATE_SCALE)
    .toString()
    .padStart(RATE_DECIMALS, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export interface PairRate {
  base: CurrencyCode;
  quote: CurrencyCode;
  /** Quote units per base unit, scaled by 10^RATE_DECIMALS. */
  scaled: bigint;
}

/**
 * Conversion factor source -> target in minor units, as a fraction N/D:
 * targetMinor = sourceMinor * N / D. Accounts for each currency's exponent
 * (e.g. JPY has 0 decimals, USD 2).
 */
function factor(
  rate: PairRate,
  source: CurrencyCode,
  target: CurrencyCode,
): { n: bigint; d: bigint } {
  const es = 10n ** BigInt(CURRENCIES[source].minorUnits);
  const et = 10n ** BigInt(CURRENCIES[target].minorUnits);

  if (source === rate.base && target === rate.quote) {
    return { n: rate.scaled * et, d: RATE_SCALE * es };
  }
  if (source === rate.quote && target === rate.base) {
    return { n: RATE_SCALE * et, d: rate.scaled * es };
  }
  throw new InvalidRateError(
    `Rate ${rate.base}/${rate.quote} cannot convert ${source} to ${target}`,
  );
}

export interface Conversion {
  /** Charged to the customer, in source minor units. */
  sourceAmount: bigint;
  /** Credited to the customer after the spread, in target minor units. */
  targetAmount: bigint;
  /** Value of sourceAmount at the mid rate, rounded down. */
  grossTargetAmount: bigint;
  /** grossTargetAmount - targetAmount: the platform's FX revenue. */
  spreadAmount: bigint;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

function validateSpread(spreadBps: number): bigint {
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps >= 10_000) {
    throw new RangeError(`Invalid spread ${spreadBps} bps`);
  }
  return BigInt(spreadBps);
}

/**
 * The customer pays a fixed source amount. The credited target amount is
 * rounded DOWN, so the platform never credits value it did not receive.
 */
export function convertFromSource(
  rate: PairRate,
  source: CurrencyCode,
  target: CurrencyCode,
  sourceAmount: bigint,
  spreadBps: number,
): Conversion {
  const spread = validateSpread(spreadBps);
  if (sourceAmount <= 0n) throw new RangeError('Amount must be positive');
  const { n, d } = factor(rate, source, target);

  const grossTargetAmount = (sourceAmount * n) / d;
  const targetAmount = (sourceAmount * n * (BPS - spread)) / (d * BPS);

  return {
    sourceAmount,
    targetAmount,
    grossTargetAmount,
    spreadAmount: grossTargetAmount - targetAmount,
  };
}

/**
 * The customer wants a fixed target amount. The charged source amount is
 * rounded UP to the smallest amount that yields at least `targetAmount`.
 */
export function convertToTarget(
  rate: PairRate,
  source: CurrencyCode,
  target: CurrencyCode,
  targetAmount: bigint,
  spreadBps: number,
): Conversion {
  const spread = validateSpread(spreadBps);
  if (targetAmount <= 0n) throw new RangeError('Amount must be positive');
  const { n, d } = factor(rate, source, target);

  const sourceAmount = ceilDiv(targetAmount * d * BPS, n * (BPS - spread));
  return convertFromSource(rate, source, target, sourceAmount, spreadBps);
}
