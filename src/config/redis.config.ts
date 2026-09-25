import { registerAs } from '@nestjs/config';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { validateConfig } from './validate-config';

class RedisEnvironmentVariables {
  @IsString()
  @IsNotEmpty()
  REDIS_HOST: string = 'localhost';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT: number = 6379;

  @IsOptional()
  @IsString()
  REDIS_PASSWORD?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(15)
  REDIS_DB: number = 0;

  /** Namespaces all queue keys, so several apps/environments can share a Redis. */
  @Matches(/^[a-z0-9-]{1,40}$/)
  QUEUE_PREFIX: string = 'finstack';
}

export const redisConfig = registerAs('redis', () => {
  const env = validateConfig('redis', RedisEnvironmentVariables, process.env);

  return {
    connection: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
      db: env.REDIS_DB,
    },
    queuePrefix: env.QUEUE_PREFIX,
  };
});

export type RedisConfig = ReturnType<typeof redisConfig>;
