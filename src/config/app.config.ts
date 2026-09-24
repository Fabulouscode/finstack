import { registerAs } from '@nestjs/config';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, Max, Min } from 'class-validator';
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
}

export const appConfig = registerAs('app', () => {
  const env = validateConfig('app', AppEnvironmentVariables, process.env);

  return {
    environment: env.NODE_ENV,
    port: env.PORT,
    isProduction: env.NODE_ENV === Environment.Production,
  };
});

export type AppConfig = ReturnType<typeof appConfig>;
