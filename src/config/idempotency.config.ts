import { registerAs } from '@nestjs/config';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { validateConfig } from './validate-config';

class IdempotencyEnvironmentVariables {
  /** How long a completed response is kept for replay. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  IDEMPOTENCY_KEY_TTL_HOURS: number = 24;

  /**
   * After this long, an in-progress key (e.g. the server crashed mid-request)
   * may be taken over by a retry. Safe because money-moving operations are
   * also idempotent in the domain layer.
   */
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(3600)
  IDEMPOTENCY_LOCK_TIMEOUT_SECONDS: number = 60;
}

export const idempotencyConfig = registerAs('idempotency', () => {
  const env = validateConfig(
    'idempotency',
    IdempotencyEnvironmentVariables,
    process.env,
  );

  return {
    ttlMs: env.IDEMPOTENCY_KEY_TTL_HOURS * 60 * 60 * 1000,
    lockTimeoutMs: env.IDEMPOTENCY_LOCK_TIMEOUT_SECONDS * 1000,
  };
});

export type IdempotencyConfig = ReturnType<typeof idempotencyConfig>;
