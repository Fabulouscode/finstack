import { HttpException, HttpStatus } from '@nestjs/common';
import { FieldError } from './problem-details';

/**
 * Base class for errors the API deliberately returns to clients.
 *
 * `code` is a stable identifier clients can branch on (e.g.
 * `INSUFFICIENT_FUNDS`), independent of the human-readable message.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: string,
    readonly detail: string,
    status: HttpStatus,
    readonly errors?: FieldError[],
  ) {
    super(detail, status);
    this.name = new.target.name;
  }
}

export class RequestValidationException extends AppException {
  constructor(errors: FieldError[]) {
    super(
      'VALIDATION_ERROR',
      'Request validation failed',
      HttpStatus.BAD_REQUEST,
      errors,
    );
  }
}
