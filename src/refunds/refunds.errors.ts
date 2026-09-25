import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class RefundNotFoundException extends AppException {
  constructor() {
    super('REFUND_NOT_FOUND', 'Refund not found', HttpStatus.NOT_FOUND);
  }
}

export class PaymentNotRefundableException extends AppException {
  constructor(status: string) {
    super(
      'PAYMENT_NOT_REFUNDABLE',
      `Only successful payments can be refunded (this one is ${status})`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class RefundExceedsRemainingException extends AppException {
  constructor(remaining: bigint, currency: string) {
    super(
      'REFUND_EXCEEDS_REMAINING',
      `At most ${remaining} ${currency} (minor units) can still be refunded`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class PaymentAlreadyRefundedException extends AppException {
  constructor() {
    super(
      'PAYMENT_ALREADY_REFUNDED',
      'This payment has already been refunded in full',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
