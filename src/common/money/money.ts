/**
 * Money is handled as `bigint` minor units internally. These helpers are the
 * only places that cross the bigint <-> number boundary (JSON has no bigint).
 */

/** Largest amount the API accepts or returns (2^53 - 1 minor units). */
export const MAX_API_AMOUNT = Number.MAX_SAFE_INTEGER;

/** Converts a validated API integer to minor units. */
export function toMinorUnits(amount: number): bigint {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`Amount ${amount} is not a safe integer`);
  }
  return BigInt(amount);
}

/**
 * Converts minor units to a JSON-safe integer. Throws rather than silently
 * losing precision if a balance ever exceeds 2^53 - 1.
 */
export function toApiAmount(amount: bigint): number {
  if (
    amount > BigInt(Number.MAX_SAFE_INTEGER) ||
    amount < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError(`Amount ${amount} exceeds the safe integer range`);
  }
  return Number(amount);
}
