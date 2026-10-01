import {
  fromMajorUnits,
  toMajorUnitNumber,
  toMajorUnitString,
} from './major-units';

describe('major-unit conversions', () => {
  it('formats minor units as exact major-unit decimals', () => {
    expect(toMajorUnitString(150_050n, 'NGN')).toBe('1500.50');
    expect(toMajorUnitString(5n, 'USD')).toBe('0.05');
    expect(toMajorUnitString(0n, 'USD')).toBe('0.00');
    expect(toMajorUnitString(500n, 'JPY')).toBe('500');
    expect(toMajorUnitNumber(150_050n, 'NGN')).toBe(1500.5);
  });

  it('parses provider amounts exactly, from numbers or strings', () => {
    expect(fromMajorUnits(1500.5, 'NGN')).toBe(150_050n);
    expect(fromMajorUnits('1500.50', 'NGN')).toBe(150_050n);
    expect(fromMajorUnits(1000, 'NGN')).toBe(100_000n);
    expect(fromMajorUnits(0.1, 'USD')).toBe(10n);
    expect(fromMajorUnits(0.29, 'USD')).toBe(29n);
    expect(fromMajorUnits('2.500', 'USD')).toBe(250n);
    expect(fromMajorUnits(500, 'JPY')).toBe(500n);
  });

  it('round-trips every cent value without drift', () => {
    for (let minor = 0n; minor < 10_000n; minor += 1n) {
      expect(fromMajorUnits(toMajorUnitNumber(minor, 'USD'), 'USD')).toBe(
        minor,
      );
    }
  });

  it('refuses amounts it cannot represent exactly, rather than rounding', () => {
    expect(() => fromMajorUnits(10.005, 'USD')).toThrow(RangeError);
    expect(() => fromMajorUnits(1.5, 'JPY')).toThrow(RangeError);
    expect(() => fromMajorUnits(-5, 'USD')).toThrow(RangeError);
    expect(() => fromMajorUnits(1e21, 'USD')).toThrow(RangeError);
    expect(() => fromMajorUnits('12abc', 'USD')).toThrow(RangeError);
    expect(() => fromMajorUnits(null, 'USD')).toThrow(RangeError);
    expect(() => fromMajorUnits(Number.NaN, 'USD')).toThrow(RangeError);
    expect(() => fromMajorUnits(10, 'XYZ')).toThrow(RangeError);
  });

  it('refuses to send amounts that would lose precision as a JSON number', () => {
    expect(() =>
      toMajorUnitNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'USD'),
    ).toThrow(RangeError);
    expect(() => toMajorUnitString(-1n, 'USD')).toThrow(RangeError);
  });
});
