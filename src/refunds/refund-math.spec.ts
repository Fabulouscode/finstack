import { reverseConversion } from './refund-math';

// ₦15,500.00 paid, $10.00 gross at 1550 NGN/USD, $9.90 credited, $0.10 margin.
const original = { charged: 1_550_000n, credited: 990n, gross: 1_000n };

describe('reverseConversion', () => {
  it('fully reverses a full refund, margin included', () => {
    expect(reverseConversion(original, 0n, 1_550_000n)).toEqual({
      walletDebit: 990n,
      revenueReversal: 10n,
      grossReversal: 1_000n,
    });
  });

  it('reverses a half refund proportionally', () => {
    expect(reverseConversion(original, 0n, 775_000n)).toEqual({
      walletDebit: 495n,
      revenueReversal: 5n,
      grossReversal: 500n,
    });
  });

  it('rounds the wallet debit up and the revenue reversal down', () => {
    // ₦100 of ₦15,500: wallet share 6.387 cents -> 7; revenue 0.0645 -> 0
    expect(reverseConversion(original, 0n, 10_000n)).toEqual({
      walletDebit: 7n,
      revenueReversal: 0n,
      grossReversal: 7n,
    });
  });

  it.each([
    [[1_550_000n]],
    [[775_000n, 775_000n]],
    [[1n, 2n, 3n, 1_549_994n]],
    [[333_333n, 333_333n, 333_333n, 550_001n]],
    [[10_000n, 10_000n, 10_000n, 1_520_000n]],
  ])('sums exactly to the original after partial refunds %p', (parts) => {
    let refunded = 0n;
    const totals = { walletDebit: 0n, revenueReversal: 0n, grossReversal: 0n };
    for (const amount of parts) {
      const reversal = reverseConversion(original, refunded, amount);
      totals.walletDebit += reversal.walletDebit;
      totals.revenueReversal += reversal.revenueReversal;
      totals.grossReversal += reversal.grossReversal;
      refunded += amount;
    }

    expect(totals).toEqual({
      walletDebit: 990n,
      revenueReversal: 10n,
      grossReversal: 1_000n,
    });
  });

  it('never reverses more revenue than was earned, at any point', () => {
    let refunded = 0n;
    let revenue = 0n;
    for (let i = 0; i < 155; i++) {
      revenue += reverseConversion(original, refunded, 10_000n).revenueReversal;
      refunded += 10_000n;
      expect(revenue).toBeLessThanOrEqual(10n);
    }
    expect(revenue).toBe(10n);
  });

  it('rejects refunds beyond the original payment', () => {
    expect(() => reverseConversion(original, 1_000_000n, 550_001n)).toThrow(
      RangeError,
    );
    expect(() => reverseConversion(original, 0n, 0n)).toThrow(RangeError);
  });
});
