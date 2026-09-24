import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class IdempotencyKeyRequiredException extends AppException {
  constructor() {
    super(
      'IDEMPOTENCY_KEY_REQUIRED',
      'This endpoint requires an Idempotency-Key header (1-255 characters: letters, digits, "-", "_", ":", ".")',
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class IdempotencyKeyReusedException extends AppException {
  constructor() {
    super(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used with a different request',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class IdempotencyRequestInProgressException extends AppException {
  constructor() {
    super(
      'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      'A request with this Idempotency-Key is still being processed. Retry shortly.',
      HttpStatus.CONFLICT,
    );
  }
}
