/**
 * Supported ISO 4217 currencies and their minor-unit exponents. Amounts are
 * always stored as integers in minor units: 1500.00 NGN -> 150000 (kobo),
 * 25.50 USD -> 2550 (cents), 500 JPY -> 500 (no minor unit).
 *
 * Add a currency here to support it everywhere.
 */
export const CURRENCIES = {
  NGN: { name: 'Nigerian naira', minorUnits: 2 },
  USD: { name: 'US dollar', minorUnits: 2 },
  EUR: { name: 'Euro', minorUnits: 2 },
  GBP: { name: 'Pound sterling', minorUnits: 2 },
  GHS: { name: 'Ghanaian cedi', minorUnits: 2 },
  KES: { name: 'Kenyan shilling', minorUnits: 2 },
  ZAR: { name: 'South African rand', minorUnits: 2 },
  JPY: { name: 'Japanese yen', minorUnits: 0 },
} as const satisfies Record<string, { name: string; minorUnits: number }>;

export type CurrencyCode = keyof typeof CURRENCIES;

export const SUPPORTED_CURRENCIES = Object.keys(CURRENCIES) as CurrencyCode[];

export function isSupportedCurrency(value: string): value is CurrencyCode {
  return Object.hasOwn(CURRENCIES, value);
}
