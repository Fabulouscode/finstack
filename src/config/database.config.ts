import { registerAs } from '@nestjs/config';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { validateConfig } from './validate-config';

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

class DatabaseEnvironmentVariables {
  @IsString()
  @IsNotEmpty()
  DATABASE_HOST: string = 'localhost';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  DATABASE_PORT: number = 5432;

  @IsString()
  @IsNotEmpty()
  DATABASE_USER: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_PASSWORD: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_NAME: string;

  @Transform(toBoolean)
  @IsBoolean()
  DATABASE_SSL: boolean = false;

  @Transform(toBoolean)
  @IsBoolean()
  DATABASE_LOGGING: boolean = false;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  DATABASE_POOL_MAX: number = 10;
}

export const databaseConfig = registerAs('database', () => {
  const env = validateConfig(
    'database',
    DatabaseEnvironmentVariables,
    process.env,
  );

  return {
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    name: env.DATABASE_NAME,
    ssl: env.DATABASE_SSL,
    logging: env.DATABASE_LOGGING,
    poolMax: env.DATABASE_POOL_MAX,
  };
});

export type DatabaseConfig = ReturnType<typeof databaseConfig>;
