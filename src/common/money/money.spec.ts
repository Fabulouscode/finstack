import { isSupportedCurrency } from './currency';
import { toApiAmount, toMinorUnits } from './money';

describe('money helpers', () => {
  it('converts safe integers to minor units and back', () => {
    expect(toMinorUnits(150_000)).toBe(150_000n);
    expect(toApiAmount(150_000n)).toBe(150_000);
  });

  it('refuses fractional or unsafe numbers', () => {
    expect(() => toMinorUnits(1500.5)).toThrow(RangeError);
    expect(() => toMinorUnits(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it('refuses to lose precision when serialising huge balances', () => {
    expect(() => toApiAmount(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
      RangeError,
    );
  });
});

describe('isSupportedCurrency', () => {
  it('accepts configured ISO codes only', () => {
    expect(isSupportedCurrency('NGN')).toBe(true);
    expect(isSupportedCurrency('JPY')).toBe(true);
    expect(isSupportedCurrency('ngn')).toBe(false);
    expect(isSupportedCurrency('toString')).toBe(false);
  });
});
