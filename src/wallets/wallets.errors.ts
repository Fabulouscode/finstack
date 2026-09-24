import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

/** Also used for wallets owned by someone else, so wallet ids can't be probed. */
export class WalletNotFoundException extends AppException {
  constructor() {
    super('WALLET_NOT_FOUND', 'Wallet not found', HttpStatus.NOT_FOUND);
  }
}

export class WalletAlreadyExistsException extends AppException {
  constructor(detail = 'This user already has a wallet') {
    super('WALLET_ALREADY_EXISTS', detail, HttpStatus.CONFLICT);
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

export class WalletCurrencyNotAllowedException extends AppException {
  constructor(allowed: string[]) {
    super(
      'WALLET_CURRENCY_NOT_ALLOWED',
      `Wallets can only be opened in: ${allowed.join(', ')}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
