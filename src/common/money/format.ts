import { CURRENCIES, isSupportedCurrency } from './currency';

/** `150000`, `NGN` -> `NGN 1,500.00`. */
export function formatMoney(
  minorUnits: string | bigint,
  currency: string,
): string {
  const exponent = isSupportedCurrency(currency)
    ? CURRENCIES[currency].minorUnits
    : 2;
  const value = BigInt(minorUnits);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(exponent);
  const whole = (abs / scale).toLocaleString('en-US');
  const fraction =
    exponent > 0 ? `.${(abs % scale).toString().padStart(exponent, '0')}` : '';
  return `${currency} ${negative ? '-' : ''}${whole}${fraction}`;
}
