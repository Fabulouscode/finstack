import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class PaymentNotFoundException extends AppException {
  constructor() {
    super('PAYMENT_NOT_FOUND', 'Payment not found', HttpStatus.NOT_FOUND);
  }
}

/** The provider is unreachable or erroring; the payment stays pending. Retry later. */
export class PaymentProviderUnavailableException extends AppException {
  constructor() {
    super(
      'PAYMENT_PROVIDER_UNAVAILABLE',
      'The payment provider is temporarily unavailable. Retry with the same Idempotency-Key.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
