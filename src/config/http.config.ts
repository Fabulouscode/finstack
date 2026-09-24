import { registerAs } from '@nestjs/config';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsInt, Matches, Max, Min } from 'class-validator';
import { validateConfig } from './validate-config';

const ORIGIN_PATTERN = /^(\*|https?:\/\/[^/\s]+)$/;

const toList = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : value;

class HttpEnvironmentVariables {
  /** Comma-separated allowed origins, or `*`. Empty disables CORS. */
  @Transform(toList)
  @IsArray()
  @Matches(ORIGIN_PATTERN, {
    each: true,
    message: 'each CORS origin must be "*" or scheme://host[:port]',
  })
  CORS_ORIGINS: string[] = [];

  /** Number of reverse proxies in front of the app (for the real client IP). */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY_HOPS: number = 0;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_TTL_SECONDS: number = 60;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_MAX: number = 100;

  /** Stricter per-endpoint limit for credential endpoints (login, register, refresh). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_RATE_LIMIT_MAX: number = 10;
}

export const httpConfig = registerAs('http', () => {
  const env = validateConfig('http', HttpEnvironmentVariables, process.env);

  return {
    corsOrigins: env.CORS_ORIGINS,
    trustProxyHops: env.TRUST_PROXY_HOPS,
    rateLimit: {
      ttlMs: env.RATE_LIMIT_TTL_SECONDS * 1000,
      max: env.RATE_LIMIT_MAX,
      authMax: env.AUTH_RATE_LIMIT_MAX,
    },
  };
});

export type HttpConfig = ReturnType<typeof httpConfig>;
