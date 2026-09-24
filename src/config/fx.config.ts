import { registerAs } from '@nestjs/config';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { validateConfig } from './validate-config';

class FxEnvironmentVariables {
  /** Platform margin on conversions, in basis points (100 = 1%). */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_000)
  FX_SPREAD_BPS: number = 100;

  /** How long a quoted rate stays valid. */
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(86_400)
  FX_QUOTE_TTL_SECONDS: number = 900;

  /** Rates older than this are refused (no quotes on stale rates). */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  FX_RATE_MAX_AGE_SECONDS: number = 86_400;
}

export const fxConfig = registerAs('fx', () => {
  const env = validateConfig('fx', FxEnvironmentVariables, process.env);

  return {
    spreadBps: env.FX_SPREAD_BPS,
    quoteTtlMs: env.FX_QUOTE_TTL_SECONDS * 1000,
    rateMaxAgeMs: env.FX_RATE_MAX_AGE_SECONDS * 1000,
  };
});

export type FxConfig = ReturnType<typeof fxConfig>;
