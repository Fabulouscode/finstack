import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HttpConfig, httpConfig } from '../../config/http.config';
import { AllExceptionsFilter } from './all-exceptions.filter';
import {
  AUTH_THROTTLER,
  DEFAULT_THROTTLER,
  isAuthRateLimited,
} from './rate-limit';
import { createValidationPipe } from './validation';

/**
 * Cross-cutting HTTP behaviour registered as global providers, so it applies
 * to every controller (including ones added in tests) without extra wiring.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [httpConfig.KEY],
      useFactory: (config: HttpConfig) => ({
        throttlers: [
          {
            name: DEFAULT_THROTTLER,
            ttl: config.rateLimit.ttlMs,
            limit: config.rateLimit.max,
          },
          {
            name: AUTH_THROTTLER,
            ttl: config.rateLimit.ttlMs,
            limit: config.rateLimit.authMax,
            skipIf: (context) => !isAuthRateLimited(context),
          },
        ],
      }),
    }),
  ],
  providers: [
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class HttpModule {}
