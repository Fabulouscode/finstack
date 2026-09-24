import {
  convertFromSource,
  convertToTarget,
  formatRate,
  InvalidRateError,
  PairRate,
  parseRate,
} from './fx-math';

const usdNgn: PairRate = {
  base: 'USD',
  quote: 'NGN',
  scaled: parseRate('1550'),
};

describe('parseRate / formatRate', () => {
  it.each([
    ['1550', '1550'],
    ['1550.25', '1550.25'],
    ['1550.2500000000', '1550.25'],
    ['0.000645', '0.000645'],
    ['0.0000000001', '0.0000000001'],
  ])('round-trips %s', (input, formatted) => {
    expect(formatRate(parseRate(input))).toBe(formatted);
  });

  it.each(['0', '0.0', '-1', '1e3', '1,550', 'abc', '', '1.12345678901', '1.'])(
    'rejects %p',
    (input) => {
      expect(() => parseRate(input)).toThrow(InvalidRateError);
    },
  );
});

describe('convertFromSource', () => {
  it('converts NGN kobo to USD cents at the mid rate without a spread', () => {
    // ₦15,500.00 at 1550 NGN/USD = $10.00
    expect(convertFromSource(usdNgn, 'NGN', 'USD', 1_550_000n, 0)).toEqual({
      sourceAmount: 1_550_000n,
      targetAmount: 1_000n,
      grossTargetAmount: 1_000n,
      spreadAmount: 0n,
    });
  });

  it('applies the spread as platform revenue', () => {
    // 1% of $10.00 = $0.10
    expect(convertFromSource(usdNgn, 'NGN', 'USD', 1_550_000n, 100)).toEqual({
      sourceAmount: 1_550_000n,
      targetAmount: 990n,
      grossTargetAmount: 1_000n,
      spreadAmount: 10n,
    });
  });

  it('rounds the credited amount down, never up', () => {
    // ₦100.00 / 1550 = $0.0645... -> 6 cents, not 7
    expect(
      convertFromSource(usdNgn, 'NGN', 'USD', 10_000n, 0).targetAmount,
    ).toBe(6n);
  });

  it('converts in the other direction of the same pair', () => {
    // $10.00 -> ₦15,500.00
    expect(
      convertFromSource(usdNgn, 'USD', 'NGN', 1_000n, 0).targetAmount,
    ).toBe(1_550_000n);
  });

  it('respects currency exponents (JPY has no minor unit)', () => {
    const usdJpy: PairRate = {
      base: 'USD',
      quote: 'JPY',
      scaled: parseRate('150.5'),
    };
    // $10.00 -> ¥1,505
    expect(
      convertFromSource(usdJpy, 'USD', 'JPY', 1_000n, 0).targetAmount,
    ).toBe(1_505n);
    // ¥1,505 -> $10.00
    expect(
      convertFromSource(usdJpy, 'JPY', 'USD', 1_505n, 0).targetAmount,
    ).toBe(1_000n);
  });

  it('handles very large amounts exactly', () => {
    const huge = 9_000_000_000_000_000_000n; // beyond Number.MAX_SAFE_INTEGER
    const result = convertFromSource(usdNgn, 'NGN', 'USD', huge, 0);
    expect(result.targetAmount).toBe(huge / 1550n);
  });

  it('rejects pairs the rate does not cover, bad spreads and non-positive amounts', () => {
    expect(() => convertFromSource(usdNgn, 'EUR', 'USD', 100n, 0)).toThrow(
      InvalidRateError,
    );
    expect(() => convertFromSource(usdNgn, 'NGN', 'USD', 100n, -1)).toThrow(
      RangeError,
    );
    expect(() => convertFromSource(usdNgn, 'NGN', 'USD', 100n, 10_000)).toThrow(
      RangeError,
    );
    expect(() => convertFromSource(usdNgn, 'NGN', 'USD', 0n, 0)).toThrow(
      RangeError,
    );
  });
});

describe('convertToTarget', () => {
  it('charges the smallest source amount that yields the target', () => {
    // $10.00 with a 1% spread: need gross $10.1010... -> ₦15,656.57 (rounded up)
    const result = convertToTarget(usdNgn, 'NGN', 'USD', 1_000n, 100);

    expect(result.targetAmount).toBeGreaterThanOrEqual(1_000n);
    const oneKoboLess = convertFromSource(
      usdNgn,
      'NGN',
      'USD',
      result.sourceAmount - 1n,
      100,
    );
    expect(oneKoboLess.targetAmount).toBeLessThan(1_000n);
  });

  it('is exact when the numbers divide evenly', () => {
    expect(convertToTarget(usdNgn, 'NGN', 'USD', 1_000n, 0)).toMatchObject({
      sourceAmount: 1_550_000n,
      targetAmount: 1_000n,
    });
  });

  it.each([1n, 7n, 99n, 1_234n, 987_654n])(
    'never credits less than requested (%s cents, awkward rate)',
    (target) => {
      const awkward: PairRate = {
        base: 'USD',
        quote: 'NGN',
        scaled: parseRate('1537.4321'),
      };
      const result = convertToTarget(awkward, 'NGN', 'USD', target, 137);

      expect(result.targetAmount).toBeGreaterThanOrEqual(target);
      expect(
        convertFromSource(awkward, 'NGN', 'USD', result.sourceAmount - 1n, 137)
          .targetAmount,
      ).toBeLessThan(target);
    },
  );
});
