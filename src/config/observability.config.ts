import { Logger } from '@nestjs/common';
import { registerAs } from '@nestjs/config';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, MinLength } from 'class-validator';
import { toBoolean } from './env-transformers';
import { validateConfig } from './validate-config';

export const LOG_FORMATS = ['json', 'pretty'] as const;
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

class ObservabilityEnvironmentVariables {
  /** `json`: one JSON object per line (log collectors); `pretty`: for people. */
  @IsOptional()
  @IsIn(LOG_FORMATS)
  LOG_FORMAT?: (typeof LOG_FORMATS)[number];

  @IsIn(LOG_LEVELS)
  LOG_LEVEL: LogLevel = 'info';

  @Transform(toBoolean)
  @IsBoolean()
  METRICS_ENABLED: boolean = true;

  /** Bearer token Prometheus must send to scrape /metrics. */
  @IsOptional()
  @MinLength(16)
  METRICS_TOKEN?: string;
}

export const observabilityConfig = registerAs('observability', () => {
  const env = validateConfig(
    'observability',
    ObservabilityEnvironmentVariables,
    process.env,
  );
  const production = process.env.NODE_ENV === 'production';
  // Unprotected metrics reveal traffic and business volumes: in production
  // /metrics stays off until a token is set.
  const metricsEnabled =
    env.METRICS_ENABLED && (!production || Boolean(env.METRICS_TOKEN));
  if (env.METRICS_ENABLED && !metricsEnabled) {
    new Logger('Config').warn(
      '/metrics is disabled: set METRICS_TOKEN to expose it in production',
    );
  }
  return {
    logFormat: env.LOG_FORMAT ?? (production ? 'json' : 'pretty'),
    logLevel: env.LOG_LEVEL,
    metricsEnabled,
    metricsToken: env.METRICS_TOKEN ?? null,
  };
});

export type ObservabilityConfig = ReturnType<typeof observabilityConfig>;
