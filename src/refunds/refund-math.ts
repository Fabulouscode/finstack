/**
 * How a refund of a converted payment unwinds the original conversion.
 *
 * Original payment: the customer paid `charged` (e.g. ₦15,500); the wallet
 * received `credited` ($9.90) out of `gross` ($10.00) at the mid rate; the
 * platform earned `gross - credited` ($0.10) as FX revenue.
 *
 * A refund of `amount` (in the charged currency) reverses those figures in
 * proportion, at the ORIGINAL rate, including the margin. Amounts are
 * computed cumulatively, as the difference between "refunded so far
 * including this refund" and "refunded so far", so partial refunds never
 * drift: once the whole payment is refunded, the reversals sum exactly to
 * the original credit, gross and revenue.
 *
 * Rounding: the wallet debit rounds UP and the revenue reversal rounds DOWN,
 * so the platform never reverses more revenue than it earned.
 */
export interface OriginalConversion {
  charged: bigint;
  credited: bigint;
  gross: bigint;
}

export interface ConversionReversal {
  /** Taken from the wallet, in the wallet currency. */
  walletDebit: bigint;
  /** FX revenue given back, in the wallet currency. */
  revenueReversal: bigint;
  /** walletDebit + revenueReversal: the FX position unwound (wallet currency). */
  grossReversal: bigint;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export function reverseConversion(
  original: OriginalConversion,
  refundedBefore: bigint,
  amount: bigint,
): ConversionReversal {
  const { charged, credited, gross } = original;
  if (
    amount <= 0n ||
    refundedBefore < 0n ||
    refundedBefore + amount > charged
  ) {
    throw new RangeError('Refund exceeds the refundable amount');
  }
  const spread = gross - credited;
  const after = refundedBefore + amount;

  const walletDebit =
    ceilDiv(credited * after, charged) -
    ceilDiv(credited * refundedBefore, charged);
  const revenueReversal =
    (spread * after) / charged - (spread * refundedBefore) / charged;

  return {
    walletDebit,
    revenueReversal,
    grossReversal: walletDebit + revenueReversal,
  };
}
