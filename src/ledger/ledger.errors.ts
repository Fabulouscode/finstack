import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class InsufficientFundsException extends AppException {
  constructor() {
    super(
      'INSUFFICIENT_FUNDS',
      'Insufficient funds',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class CurrencyMismatchException extends AppException {
  constructor(detail = 'All accounts in a posting must share its currency') {
    super('CURRENCY_MISMATCH', detail, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

/** The reference was already used for a different posting. */
export class LedgerReferenceConflictException extends AppException {
  constructor() {
    super(
      'LEDGER_REFERENCE_CONFLICT',
      'This reference was already used for a different transaction',
      HttpStatus.CONFLICT,
    );
  }
}

export class TransactionAlreadyReversedException extends AppException {
  constructor() {
    super(
      'TRANSACTION_ALREADY_REVERSED',
      'This transaction has already been reversed',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * A posting that violates double-entry rules. Always a programming error in
 * the calling code (never user input), so it surfaces as a 500.
 */
export class InvalidPostingError extends Error {
  constructor(reason: string) {
    super(`Invalid ledger posting: ${reason}`);
    this.name = 'InvalidPostingError';
  }
}

export class LedgerAccountNotFoundError extends Error {
  constructor(ids: string[]) {
    super(`Ledger account(s) not found: ${ids.join(', ')}`);
    this.name = 'LedgerAccountNotFoundError';
  }
}
