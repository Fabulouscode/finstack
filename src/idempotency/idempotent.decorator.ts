import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { ApiProblemResponse } from '../docs/api-problem-response.decorator';
import {
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyInterceptor,
} from './idempotency.interceptor';

/**
 * Requires an Idempotency-Key header and replays the stored response for
 * retries. Use on every endpoint that moves money or creates resources.
 */
export function Idempotent(): MethodDecorator {
  return applyDecorators(
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: IDEMPOTENCY_KEY_HEADER,
      required: true,
      description:
        'Unique key per logical operation (e.g. a UUID). Retrying with the same key and body returns the original response ' +
        '(with `Idempotent-Replayed: true`) instead of repeating the operation. Keys expire after IDEMPOTENCY_KEY_TTL_HOURS.',
      example: '5f1d7e0c-8a3b-4c2d-9e6f-1a2b3c4d5e6f',
    }),
    ApiProblemResponse(
      400,
      'IDEMPOTENCY_KEY_REQUIRED: missing or malformed Idempotency-Key header',
    ),
    ApiProblemResponse(
      409,
      'IDEMPOTENCY_REQUEST_IN_PROGRESS: a request with this key is still running',
    ),
    ApiProblemResponse(
      422,
      'IDEMPOTENCY_KEY_REUSED: the key was used with a different request body',
    ),
  );
}
