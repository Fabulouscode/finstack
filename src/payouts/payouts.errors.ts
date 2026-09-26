import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class PayoutNotFoundException extends AppException {
  constructor() {
    super('PAYOUT_NOT_FOUND', 'Payout not found', HttpStatus.NOT_FOUND);
  }
}

export class PayoutDestinationNotFoundException extends AppException {
  constructor() {
    super(
      'PAYOUT_DESTINATION_NOT_FOUND',
      'Payout destination not found',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class PayoutDestinationAlreadyExistsException extends AppException {
  constructor() {
    super(
      'PAYOUT_DESTINATION_ALREADY_EXISTS',
      'This bank account is already saved',
      HttpStatus.CONFLICT,
    );
  }
}

/** The provider couldn't verify or save the bank account. */
export class PayoutDestinationRejectedException extends AppException {
  constructor(detail: string) {
    super(
      'PAYOUT_DESTINATION_REJECTED',
      detail,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/** New bank accounts wait PAYOUT_DESTINATION_COOLDOWN_MINUTES before payouts. */
export class PayoutDestinationCoolingOffException extends AppException {
  constructor(availableAt: Date) {
    super(
      'PAYOUT_DESTINATION_COOLING_OFF',
      `This bank account was added recently and can receive payouts from ${availableAt.toISOString()}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
