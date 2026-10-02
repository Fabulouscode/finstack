import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { IDEMPOTENCY_KEY_HEADER } from './idempotency.interceptor';

/**
 * The request's Idempotency-Key (validated by IdempotencyInterceptor, via
 * @Idempotent()). A custom decorator rather than @Headers(), which Swagger
 * would document a second time next to @Idempotent()'s header, giving
 * generated clients two copies of the same header.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    String(
      context.switchToHttp().getRequest<Request>().headers[
        IDEMPOTENCY_KEY_HEADER.toLowerCase()
      ] ?? '',
    ),
);
