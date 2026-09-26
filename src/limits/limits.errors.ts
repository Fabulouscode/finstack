import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class LimitExceededException extends AppException {
  constructor(detail: string) {
    super('LIMIT_EXCEEDED', detail, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

export class LimitRuleNotFoundException extends AppException {
  constructor() {
    super('LIMIT_RULE_NOT_FOUND', 'Limit rule not found', HttpStatus.NOT_FOUND);
  }
}

export class LimitRuleAlreadyRetiredException extends AppException {
  constructor() {
    super(
      'LIMIT_RULE_ALREADY_RETIRED',
      'This limit rule was already superseded or retired',
      HttpStatus.CONFLICT,
    );
  }
}
