import { registerAs } from '@nestjs/config';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { ConfigValidationError, validateConfig } from './validate-config';

/** Prefix of the placeholder secret shipped in `.env.example`. */
export const PLACEHOLDER_SECRET_PREFIX = 'change-me';

class AuthEnvironmentVariables {
  /** HMAC key for access tokens. Generate with `openssl rand -base64 48`. */
  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET: string;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(86_400)
  JWT_ACCESS_TTL_SECONDS: number = 900;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  REFRESH_TOKEN_TTL_DAYS: number = 30;

  @IsString()
  @IsNotEmpty()
  JWT_ISSUER: string = 'finstack';

  @IsString()
  @IsNotEmpty()
  JWT_AUDIENCE: string = 'finstack-api';
}

export const authConfig = registerAs('auth', () => {
  const env = validateConfig('auth', AuthEnvironmentVariables, process.env);

  if (
    process.env.NODE_ENV === 'production' &&
    env.JWT_ACCESS_SECRET.startsWith(PLACEHOLDER_SECRET_PREFIX)
  ) {
    throw new ConfigValidationError('auth', [
      'JWT_ACCESS_SECRET: the example placeholder must not be used in production',
    ]);
  }

  return {
    accessToken: {
      secret: env.JWT_ACCESS_SECRET,
      ttlSeconds: env.JWT_ACCESS_TTL_SECONDS,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    },
    refreshToken: {
      ttlMs: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    },
  };
});

export type AuthConfig = ReturnType<typeof authConfig>;
