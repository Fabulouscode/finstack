import { registerAs } from '@nestjs/config';
import { IsIn } from 'class-validator';
import { SUPPORTED_CURRENCIES } from '../common/money/currency';
import type { CurrencyCode } from '../common/money/currency';
import { validateConfig } from './validate-config';

class WalletsEnvironmentVariables {
  /** Base currency for wallets opened without an explicit currency. */
  @IsIn(SUPPORTED_CURRENCIES)
  DEFAULT_WALLET_CURRENCY: CurrencyCode = 'USD';
}

export const walletsConfig = registerAs('wallets', () => {
  const env = validateConfig(
    'wallets',
    WalletsEnvironmentVariables,
    process.env,
  );

  return { defaultCurrency: env.DEFAULT_WALLET_CURRENCY };
});

export type WalletsConfig = ReturnType<typeof walletsConfig>;
