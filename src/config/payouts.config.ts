import { registerAs } from '@nestjs/config';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { validateConfig } from './validate-config';

class PayoutsEnvironmentVariables {
  /**
   * How long a newly added bank account waits before it can receive
   * payouts (0 = immediately). The account owner is emailed when one is
   * added, so this is their window to react to an account takeover.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(7 * 24 * 60)
  PAYOUT_DESTINATION_COOLDOWN_MINUTES: number = 0;
}

export const payoutsConfig = registerAs('payouts', () => {
  const env = validateConfig(
    'payouts',
    PayoutsEnvironmentVariables,
    process.env,
  );
  return {
    destinationCooldownMinutes: env.PAYOUT_DESTINATION_COOLDOWN_MINUTES,
  };
});

export type PayoutsConfig = ReturnType<typeof payoutsConfig>;
