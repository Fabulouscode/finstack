import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export enum TransactionType {
  Transfer = 'transfer',
  Deposit = 'deposit',
  Withdrawal = 'withdrawal',
  Payment = 'payment',
  Refund = 'refund',
  Fee = 'fee',
  Reversal = 'reversal',
  Conversion = 'conversion',
}

export enum TransactionStatus {
  Pending = 'pending',
  Processing = 'processing',
  Successful = 'successful',
  Failed = 'failed',
  Reversed = 'reversed',
  Cancelled = 'cancelled',
  Expired = 'expired',
}

const {
  Pending,
  Processing,
  Successful,
  Failed,
  Reversed,
  Cancelled,
  Expired,
} = TransactionStatus;

/**
 * Every allowed status change. Anything not listed is rejected, in code and
 * by the trg_transactions_status_transition database trigger (kept in sync by
 * an integration test that tries every pair against PostgreSQL).
 */
export const TRANSACTION_TRANSITIONS: Readonly<
  Record<TransactionStatus, readonly TransactionStatus[]>
> = {
  [Pending]: [Processing, Successful, Failed, Cancelled, Expired],
  [Processing]: [Successful, Failed],
  [Successful]: [Reversed],
  [Failed]: [],
  [Reversed]: [],
  [Cancelled]: [],
  [Expired]: [],
};

export function canTransition(
  from: TransactionStatus,
  to: TransactionStatus,
): boolean {
  return TRANSACTION_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: TransactionStatus): boolean {
  return TRANSACTION_TRANSITIONS[status].length === 0;
}

export class InvalidTransactionStateException extends AppException {
  constructor(from: TransactionStatus, to: TransactionStatus) {
    super(
      'INVALID_TRANSACTION_STATE',
      `A ${from} transaction cannot become ${to}`,
      HttpStatus.CONFLICT,
    );
  }
}

export function assertTransition(
  from: TransactionStatus,
  to: TransactionStatus,
): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransactionStateException(from, to);
  }
}
