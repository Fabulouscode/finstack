import { registerAs } from '@nestjs/config';
import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { ConfigValidationError, validateConfig } from './validate-config';

export const KNOWN_PAYMENT_PROVIDERS = ['mock'] as const;
export type PaymentProviderName = (typeof KNOWN_PAYMENT_PROVIDERS)[number];

const toList = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : value;

class PaymentsEnvironmentVariables {
  /** Providers to enable, comma-separated. */
  @Transform(toList)
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(KNOWN_PAYMENT_PROVIDERS, { each: true })
  PAYMENT_PROVIDERS: PaymentProviderName[] = ['mock'];

  @IsOptional()
  @IsIn(KNOWN_PAYMENT_PROVIDERS)
  DEFAULT_PAYMENT_PROVIDER?: PaymentProviderName;

  /** HMAC secret the mock provider signs its webhooks with. */
  @IsOptional()
  @IsString()
  @MinLength(16)
  MOCK_PROVIDER_WEBHOOK_SECRET?: string;
}

export const paymentsConfig = registerAs('payments', () => {
  const env = validateConfig(
    'payments',
    PaymentsEnvironmentVariables,
    process.env,
  );
  const enabled = [...new Set(env.PAYMENT_PROVIDERS)];
  const defaultProvider = env.DEFAULT_PAYMENT_PROVIDER ?? enabled[0];
  const violations: string[] = [];

  if (!defaultProvider || !enabled.includes(defaultProvider)) {
    violations.push(
      'DEFAULT_PAYMENT_PROVIDER must be one of PAYMENT_PROVIDERS',
    );
  }
  if (enabled.includes('mock')) {
    if (process.env.NODE_ENV === 'production') {
      violations.push(
        'PAYMENT_PROVIDERS: the mock provider must not be enabled in production',
      );
    }
    if (!env.MOCK_PROVIDER_WEBHOOK_SECRET) {
      violations.push(
        'MOCK_PROVIDER_WEBHOOK_SECRET is required when the mock provider is enabled',
      );
    }
  }
  if (violations.length > 0) {
    throw new ConfigValidationError('payments', violations);
  }

  return {
    enabledProviders: enabled,
    defaultProvider: defaultProvider as PaymentProviderName,
    mock: { webhookSecret: env.MOCK_PROVIDER_WEBHOOK_SECRET ?? '' },
  };
});

export type PaymentsConfig = ReturnType<typeof paymentsConfig>;
