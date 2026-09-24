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
}

export const appConfig = registerAs('app', () => {
  const env = validateConfig('app', AppEnvironmentVariables, process.env);
  const isProduction = env.NODE_ENV === Environment.Production;

  return {
    environment: env.NODE_ENV,
    port: env.PORT,
    isProduction,
    swaggerEnabled: env.SWAGGER_ENABLED ?? !isProduction,
  };
});

export type AppConfig = ReturnType<typeof appConfig>;
