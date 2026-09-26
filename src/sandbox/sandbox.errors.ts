import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

/** 404, so production deployments don't even reveal the sandbox API. */
export class SandboxUnavailableException extends AppException {
  constructor() {
    super(
      'NOT_FOUND',
      'The sandbox API is only available where the mock provider is enabled',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class NotSimulatableException extends AppException {
  constructor(detail: string) {
    super('NOT_SIMULATABLE', detail, HttpStatus.CONFLICT);
  }
}
