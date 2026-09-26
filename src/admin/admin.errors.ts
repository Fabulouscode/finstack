import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class UserNotFoundException extends AppException {
  constructor() {
    super('USER_NOT_FOUND', 'User not found', HttpStatus.NOT_FOUND);
  }
}

export class CannotSuspendSelfException extends AppException {
  constructor() {
    super(
      'CANNOT_SUSPEND_SELF',
      'Admins cannot suspend their own account',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class InvalidStatusChangeException extends AppException {
  constructor(detail: string) {
    super('INVALID_STATUS_CHANGE', detail, HttpStatus.CONFLICT);
  }
}
