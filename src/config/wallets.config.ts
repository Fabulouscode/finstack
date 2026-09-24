import { registerAs } from '@nestjs/config';
import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
} from 'class-validator';
import { SUPPORTED_CURRENCIES } from '../common/money/currency';
import type { CurrencyCode } from '../common/money/currency';
import { ConfigValidationError, validateConfig } from './validate-config';

const toList = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : value;

export enum WalletsPerOwner {
  /** One wallet per user; foreign-currency payments convert into it. */
  Single = 'single',
  /** A wallet per allowed currency; one of them is the primary wallet. */
  Multiple = 'multiple',
}

class WalletsEnvironmentVariables {
  @IsEnum(WalletsPerOwner)
  WALLETS_PER_OWNER: WalletsPerOwner = WalletsPerOwner.Single;

  /** Currency of the first/primary wallet when none is specified. */
  @IsIn(SUPPORTED_CURRENCIES)
  DEFAULT_WALLET_CURRENCY: CurrencyCode = 'USD';

  /**
   * Base currencies end users may choose when opening a wallet. Defaults to
   * just DEFAULT_WALLET_CURRENCY, i.e. users cannot choose.
   */
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(SUPPORTED_CURRENCIES, { each: true })
  ALLOWED_WALLET_CURRENCIES?: CurrencyCode[];
}

export const walletsConfig = registerAs('wallets', () => {
  const env = validateConfig(
    'wallets',
    WalletsEnvironmentVariables,
    process.env,
  );
  const allowed = env.ALLOWED_WALLET_CURRENCIES ?? [
    env.DEFAULT_WALLET_CURRENCY,
  ];

  if (!allowed.includes(env.DEFAULT_WALLET_CURRENCY)) {
    throw new ConfigValidationError('wallets', [
      'ALLOWED_WALLET_CURRENCIES must include DEFAULT_WALLET_CURRENCY',
    ]);
  }

  return {
    walletsPerOwner: env.WALLETS_PER_OWNER,
    defaultCurrency: env.DEFAULT_WALLET_CURRENCY,
    allowedCurrencies: [...new Set(allowed)],
  };
});

export type WalletsConfig = ReturnType<typeof walletsConfig>;
