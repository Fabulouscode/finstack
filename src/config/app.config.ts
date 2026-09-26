import { registerAs } from '@nestjs/config';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { toBoolean } from './env-transformers';
import { validateConfig } from './validate-config';

export enum Environment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

class AppEnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  /** Defaults to enabled everywhere except production. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  SWAGGER_ENABLED?: boolean;

  /**
   * A sandbox deployment for integrators: simulated money only. Allows the
   * mock provider even with NODE_ENV=production, issues fsk_test_ keys and
   * refuses live provider keys.
   */
  @Transform(toBoolean)
  @IsBoolean()
  SANDBOX_MODE: boolean = false;
}

/** SANDBOX_MODE, for config namespaces that need it before DI exists. */
export function isSandboxMode(): boolean {
  return toBoolean({ value: process.env.SANDBOX_MODE }) === true;
}

export const appConfig = registerAs('app', () => {
  const env = validateConfig('app', AppEnvironmentVariables, process.env);
  const isProduction = env.NODE_ENV === Environment.Production;

  return {
    environment: env.NODE_ENV,
    port: env.PORT,
    isProduction,
    /** Real money can move: production and not a sandbox. */
    isLive: isProduction && !env.SANDBOX_MODE,
    sandbox: env.SANDBOX_MODE,
    swaggerEnabled: env.SWAGGER_ENABLED ?? !isProduction,
  };
});

export type AppConfig = ReturnType<typeof appConfig>;
