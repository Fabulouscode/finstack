import { CURRENCIES, isSupportedCurrency } from './currency';

/**
 * Conversions for providers that express amounts in major units (e.g.
 * Flutterwave: 1500.50 NGN, not 150050 kobo). Exact decimal string
 * arithmetic only: money never passes through floating-point maths.
 */

function exponentOf(currency: string): number {
  if (!isSupportedCurrency(currency)) {
    throw new RangeError(`Unsupported currency "${currency}"`);
  }
  return CURRENCIES[currency].minorUnits;
}

/** 150050n NGN -> "1500.50"; 500n JPY -> "500". */
export function toMajorUnitString(minor: bigint, currency: string): string {
  if (minor < 0n) {
    throw new RangeError('Amounts must not be negative');
  }
  const exponent = exponentOf(currency);
  if (exponent === 0) return minor.toString();
  const scale = 10n ** BigInt(exponent);
  const fraction = (minor % scale).toString().padStart(exponent, '0');
  return `${minor / scale}.${fraction}`;
}

/**
 * 150050n NGN -> 1500.5, as a JSON number. Refused when the value is too
 * large to survive as a double, so the provider always receives exactly the
 * amount we meant.
 */
export function toMajorUnitNumber(minor: bigint, currency: string): number {
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Amount too large to send in major units');
  }
  return Number(toMajorUnitString(minor, currency));
}

/**
 * A provider's major-unit amount (number or string) -> minor units, exactly.
 * Refuses anything that isn't a plain non-negative decimal, or that has more
 * decimals than the currency allows (beyond trailing zeros), rather than
 * rounding money.
 */
export function fromMajorUnits(value: unknown, currency: string): bigint {
  const exponent = exponentOf(currency);
  const text =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  // Exponent notation (1e21, 5e-7) is never a real money amount.
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new RangeError(`Not a valid ${currency} amount: ${String(value)}`);
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > exponent) {
    throw new RangeError(
      `${String(value)} has more decimals than ${currency} allows`,
    );
  }
  return (
    BigInt(whole) * 10n ** BigInt(exponent) +
    BigInt(fraction.padEnd(exponent, '0') || '0')
  );
}
