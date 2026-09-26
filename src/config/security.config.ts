import { Logger } from '@nestjs/common';
import { registerAs } from '@nestjs/config';
import { IsOptional, Matches } from 'class-validator';
import { ConfigValidationError, validateConfig } from './validate-config';

/**
 * Used outside production when DATA_ENCRYPTION_KEY is unset, so a fresh
 * checkout runs. Public, hence refused in production.
 */
export const DEVELOPMENT_ENCRYPTION_KEY = Buffer.from(
  'finstack-development-key-32bytes',
).toString('base64');

class SecurityEnvironmentVariables {
  /**
   * 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts secrets
   * FinStack must be able to read back, such as webhook signing secrets.
   */
  @IsOptional()
  @Matches(/^[A-Za-z0-9+/]{43}=$/, {
    message: 'DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded',
  })
  DATA_ENCRYPTION_KEY?: string;
}

export const securityConfig = registerAs('security', () => {
  const env = validateConfig(
    'security',
    SecurityEnvironmentVariables,
    process.env,
  );
  const production = process.env.NODE_ENV === 'production';
  const key = env.DATA_ENCRYPTION_KEY ?? DEVELOPMENT_ENCRYPTION_KEY;

  if (production && key === DEVELOPMENT_ENCRYPTION_KEY) {
    throw new ConfigValidationError('security', [
      'DATA_ENCRYPTION_KEY is required in production (openssl rand -base64 32)',
    ]);
  }
  if (!env.DATA_ENCRYPTION_KEY && process.env.NODE_ENV !== 'test') {
    new Logger('Config').warn(
      'DATA_ENCRYPTION_KEY is not set; using the public development key',
    );
  }
  return { dataEncryptionKey: Buffer.from(key, 'base64') };
});

export type SecurityConfig = ReturnType<typeof securityConfig>;
