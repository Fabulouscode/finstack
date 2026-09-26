export interface FeeSchedule {
  /** Minor units. */
  fixedAmount: bigint;
  /** 1 bps = 0.01%. */
  percentageBps: number;
  minAmount: bigint;
  maxAmount: bigint | null;
}

/**
 * fixed + amount × bps / 10 000, rounded UP to the minor unit, then held
 * within [min, max]. Exact integer arithmetic; never more than the amount
 * itself (callers refuse amounts that don't cover their fee).
 */
export function calculateFee(amount: bigint, schedule: FeeSchedule): bigint {
  if (amount <= 0n) {
    throw new Error('Fee amount must be positive');
  }
  const percentage =
    (amount * BigInt(schedule.percentageBps) + 9_999n) / 10_000n;
  let fee = schedule.fixedAmount + percentage;
  if (fee < schedule.minAmount) fee = schedule.minAmount;
  if (schedule.maxAmount !== null && fee > schedule.maxAmount) {
    fee = schedule.maxAmount;
  }
  return fee;
}
