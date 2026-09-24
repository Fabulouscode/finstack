import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

/** Same error for unknown email and wrong password, so accounts can't be enumerated. */
export class InvalidCredentialsException extends AppException {
  constructor() {
    super(
      'INVALID_CREDENTIALS',
      'Email or password is incorrect',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class AccountSuspendedException extends AppException {
  constructor() {
    super(
      'ACCOUNT_SUSPENDED',
      'This account has been suspended',
      HttpStatus.FORBIDDEN,
    );
  }
}

/** Unknown, expired, revoked or reused refresh token. Deliberately not distinguished. */
export class InvalidRefreshTokenException extends AppException {
  constructor() {
    super(
      'INVALID_REFRESH_TOKEN',
      'Refresh token is invalid or expired. Sign in again.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class AuthenticationRequiredException extends AppException {
  constructor(detail = 'A valid access token is required') {
    super('UNAUTHENTICATED', detail, HttpStatus.UNAUTHORIZED);
  }
}

export class InsufficientRoleException extends AppException {
  constructor() {
    super(
      'FORBIDDEN',
      'You do not have permission to perform this action',
      HttpStatus.FORBIDDEN,
    );
  }
}
