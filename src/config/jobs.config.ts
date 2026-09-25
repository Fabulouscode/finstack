import { registerAs } from '@nestjs/config';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, Max, Min } from 'class-validator';
import { toBoolean } from './env-transformers';
import { validateConfig } from './validate-config';

class JobsEnvironmentVariables {
  /** Run the outbox relay and queue workers in this process. */
  @Transform(toBoolean)
  @IsBoolean()
  WORKERS_ENABLED: boolean = true;

  @Type(() => Number)
  @IsInt()
  @Min(50)
  @Max(60_000)
  OUTBOX_POLL_INTERVAL_MS: number = 500;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  WEBHOOK_MAX_ATTEMPTS: number = 8;

  /** First retry delay; doubles on each attempt (exponential backoff). */
  @Type(() => Number)
  @IsInt()
  @Min(50)
  @Max(600_000)
  WEBHOOK_RETRY_BACKOFF_MS: number = 2_000;
}

export const jobsConfig = registerAs('jobs', () => {
  const env = validateConfig('jobs', JobsEnvironmentVariables, process.env);

  return {
    workersEnabled: env.WORKERS_ENABLED,
    outboxPollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    webhookMaxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
    webhookRetryBackoffMs: env.WEBHOOK_RETRY_BACKOFF_MS,
  };
});

export type JobsConfig = ReturnType<typeof jobsConfig>;
