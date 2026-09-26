import { registerAs } from '@nestjs/config';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { toBoolean } from './env-transformers';
import { validateConfig } from './validate-config';

class OutboundWebhooksEnvironmentVariables {
  /** Attempts per delivery before it is marked failed (redeliverable). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  OUTBOUND_WEBHOOK_MAX_ATTEMPTS: number = 10;

  /** First retry delay; doubles on each attempt (30s, 1m, 2m, ... ~4h). */
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(3_600_000)
  OUTBOUND_WEBHOOK_BACKOFF_MS: number = 30_000;

  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  @Max(30_000)
  OUTBOUND_WEBHOOK_TIMEOUT_MS: number = 10_000;

  /** An endpoint is disabled after this many deliveries fail in a row. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000)
  OUTBOUND_WEBHOOK_DISABLE_AFTER_FAILURES: number = 20;

  /**
   * Allow endpoints on private, loopback and link-local addresses. Off in
   * production by default (it would let customers probe your network).
   */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  OUTBOUND_WEBHOOK_ALLOW_PRIVATE_URLS?: boolean;
}

export const outboundWebhooksConfig = registerAs('outboundWebhooks', () => {
  const env = validateConfig(
    'outboundWebhooks',
    OutboundWebhooksEnvironmentVariables,
    process.env,
  );
  const production = process.env.NODE_ENV === 'production';
  return {
    maxAttempts: env.OUTBOUND_WEBHOOK_MAX_ATTEMPTS,
    backoffMs: env.OUTBOUND_WEBHOOK_BACKOFF_MS,
    timeoutMs: env.OUTBOUND_WEBHOOK_TIMEOUT_MS,
    disableAfterFailures: env.OUTBOUND_WEBHOOK_DISABLE_AFTER_FAILURES,
    allowPrivateUrls: env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_URLS ?? !production,
    /** Plain http is accepted wherever private URLs are (local development). */
    requireHttps: production,
  };
});

export type OutboundWebhooksConfig = ReturnType<typeof outboundWebhooksConfig>;
