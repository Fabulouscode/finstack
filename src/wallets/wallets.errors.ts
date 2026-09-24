import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

/** Also used for wallets owned by someone else, so wallet ids can't be probed. */
export class WalletNotFoundException extends AppException {
  constructor() {
    super('WALLET_NOT_FOUND', 'Wallet not found', HttpStatus.NOT_FOUND);
  }
}

export class WalletAlreadyExistsException extends AppException {
  constructor(currency: string) {
    super(
      'WALLET_ALREADY_EXISTS',
      `A ${currency} wallet already exists for this user`,
      HttpStatus.CONFLICT,
    );
  }
}

export class WalletNotActiveException extends AppException {
  constructor() {
    super(
      'WALLET_NOT_ACTIVE',
      'The wallet is frozen or closed and cannot move money',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class InvalidCursorException extends AppException {
  constructor() {
    super(
      'INVALID_CURSOR',
      'The pagination cursor is invalid',
      HttpStatus.BAD_REQUEST,
    );
  }
}
