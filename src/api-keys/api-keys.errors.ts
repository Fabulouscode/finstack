import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class InvalidApiKeyException extends AppException {
  constructor() {
    super(
      'INVALID_API_KEY',
      'The API key is invalid, revoked or expired',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class ApiKeyNotAllowedException extends AppException {
  constructor() {
    super(
      'API_KEY_NOT_ALLOWED',
      'API keys cannot be used on this endpoint; sign in as a user',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class ApiKeyScopeMissingException extends AppException {
  constructor(scope: string) {
    super(
      'API_KEY_SCOPE_MISSING',
      `This API key lacks the "${scope}" scope`,
      HttpStatus.FORBIDDEN,
    );
  }
}

export class ApiKeyScopeNotGrantableException extends AppException {
  constructor(scopes: string[]) {
    super(
      'API_KEY_SCOPE_NOT_GRANTABLE',
      `You cannot grant these scopes: ${scopes.join(', ')}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ApiKeyNotFoundException extends AppException {
  constructor() {
    super('API_KEY_NOT_FOUND', 'API key not found', HttpStatus.NOT_FOUND);
  }
}
