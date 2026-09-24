import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class EmailAlreadyRegisteredException extends AppException {
  constructor() {
    super(
      'EMAIL_ALREADY_REGISTERED',
      'An account with this email already exists',
      HttpStatus.CONFLICT,
    );
  }
}

export class UserNotFoundException extends AppException {
  constructor() {
    super('USER_NOT_FOUND', 'User not found', HttpStatus.NOT_FOUND);
  }
}
