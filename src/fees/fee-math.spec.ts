import { calculateFee, FeeSchedule } from './fee-math';

const schedule = (overrides: Partial<FeeSchedule> = {}): FeeSchedule => ({
  fixedAmount: 0n,
  percentageBps: 0,
  minAmount: 0n,
  maxAmount: null,
  ...overrides,
});

describe('calculateFee', () => {
  it.each([
    // [amount, schedule, fee]
    [10_000n, { percentageBps: 150 }, 150n], // 1.5% of $100.00
    [10_001n, { percentageBps: 150 }, 151n], // 150.015 rounds up
    [10_000n, { fixedAmount: 30n, percentageBps: 290 }, 320n], // 2.9% + 30¢
    [100n, { percentageBps: 150, minAmount: 50n }, 50n], // minimum
    [20_000_000n, { percentageBps: 150, maxAmount: 200_000n }, 200_000n], // cap
    [5_000n, {}, 0n], // no fee
  ])('%s with %o is %s', (amount, overrides, fee) => {
    expect(calculateFee(amount, schedule(overrides))).toBe(fee);
  });

  it('is exact for large amounts', () => {
    expect(
      calculateFee(9_007_199_254_740_993n, schedule({ percentageBps: 1 })),
    ).toBe(900_719_925_475n);
  });

  it('refuses non-positive amounts', () => {
    expect(() => calculateFee(0n, schedule())).toThrow();
  });
});
