import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class AmountBelowFeeException extends AppException {
  constructor(fee: string) {
    super(
      'AMOUNT_TOO_SMALL',
      `The amount does not cover the fee of ${fee}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class FeeRuleNotFoundException extends AppException {
  constructor() {
    super('FEE_RULE_NOT_FOUND', 'Fee rule not found', HttpStatus.NOT_FOUND);
  }
}

export class FeeRuleAlreadyRetiredException extends AppException {
  constructor() {
    super(
      'FEE_RULE_ALREADY_RETIRED',
      'This fee rule was already superseded or retired',
      HttpStatus.CONFLICT,
    );
  }
}
