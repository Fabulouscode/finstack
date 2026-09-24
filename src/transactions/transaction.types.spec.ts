import {
  assertTransition,
  canTransition,
  InvalidTransactionStateException,
  isTerminal,
  TransactionStatus,
} from './transaction.types';

const {
  Pending,
  Processing,
  Successful,
  Failed,
  Reversed,
  Cancelled,
  Expired,
} = TransactionStatus;

describe('transaction state machine', () => {
  it.each([
    [Pending, Processing],
    [Pending, Successful],
    [Pending, Failed],
    [Pending, Cancelled],
    [Pending, Expired],
    [Processing, Successful],
    [Processing, Failed],
    [Successful, Reversed],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each([
    [Successful, Failed],
    [Failed, Successful],
    [Processing, Pending],
    [Processing, Cancelled],
    [Reversed, Successful],
    [Expired, Processing],
    [Cancelled, Pending],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(
      InvalidTransactionStateException,
    );
  });

  it('treats failed, reversed, cancelled and expired as terminal', () => {
    expect([Failed, Reversed, Cancelled, Expired].every(isTerminal)).toBe(true);
    expect([Pending, Processing, Successful].some(isTerminal)).toBe(false);
  });
});
