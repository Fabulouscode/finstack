import { isSupportedCurrency } from '../common/money/currency';
import { InvalidPostingError } from './ledger.errors';
import { EntryDirection } from './ledger.types';

export interface PostingEntry {
  accountId: string;
  direction: EntryDirection;
  /** Minor units, strictly positive. */
  amount: bigint;
}

export interface PostingInput {
  /** Idempotency key: posting the same reference twice has one effect. */
  reference: string;
  description: string;
  currency: string;
  entries: PostingEntry[];
  metadata?: Record<string, unknown>;
  reversalOfId?: string;
}

/**
 * Enforces double-entry rules before touching the database and returns the
 * transaction amount (total debits == total credits).
 */
export function validatePosting(input: PostingInput): bigint {
  if (input.reference.trim().length === 0 || input.reference.length > 255) {
    throw new InvalidPostingError('reference must be 1-255 characters');
  }
  if (!isSupportedCurrency(input.currency)) {
    throw new InvalidPostingError(`unsupported currency ${input.currency}`);
  }
  if (input.entries.length < 2) {
    throw new InvalidPostingError('at least two entries are required');
  }

  let debits = 0n;
  let credits = 0n;
  for (const entry of input.entries) {
    if (typeof entry.amount !== 'bigint' || entry.amount <= 0n) {
      throw new InvalidPostingError('entry amounts must be positive bigints');
    }
    if (entry.direction === EntryDirection.Debit) {
      debits += entry.amount;
    } else {
      credits += entry.amount;
    }
  }

  if (debits === 0n || credits === 0n) {
    throw new InvalidPostingError(
      'a posting needs both debit and credit entries',
    );
  }
  if (debits !== credits) {
    throw new InvalidPostingError(
      `debits (${debits}) must equal credits (${credits})`,
    );
  }
  return debits;
}

/** Order-insensitive fingerprint of the entries, for idempotent replay checks. */
export function entriesFingerprint(
  entries: Pick<PostingEntry, 'accountId' | 'direction' | 'amount'>[],
): string {
  return entries
    .map((e) => `${e.accountId}:${e.direction}:${e.amount}`)
    .sort()
    .join('|');
}
