import { registerAs } from '@nestjs/config';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { ConfigValidationError, validateConfig } from './validate-config';

export const KNOWN_PAYMENT_PROVIDERS = ['mock', 'paystack'] as const;
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

  /** Paystack secret key: `sk_test_...` or `sk_live_...`. Also signs webhooks. */
  @IsOptional()
  @Matches(/^sk_(test|live)_[A-Za-z0-9]+$/, {
    message: 'PAYSTACK_SECRET_KEY must look like sk_test_... or sk_live_...',
  })
  PAYSTACK_SECRET_KEY?: string;

  @IsUrl({
    require_tld: false,
    protocols: ['https', 'http'],
    require_protocol: true,
  })
  PAYSTACK_BASE_URL: string = 'https://api.paystack.co';

  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  @Max(60_000)
  PAYSTACK_TIMEOUT_MS: number = 10_000;
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
  if (enabled.includes('paystack')) {
    const key = env.PAYSTACK_SECRET_KEY;
    const production = process.env.NODE_ENV === 'production';
    if (!key) {
      violations.push(
        'PAYSTACK_SECRET_KEY is required when Paystack is enabled',
      );
    } else if (production && key.startsWith('sk_test_')) {
      violations.push(
        'PAYSTACK_SECRET_KEY: a test key must not be used in production',
      );
    } else if (!production && key.startsWith('sk_live_')) {
      // Guard against real charges from a laptop or CI.
      violations.push(
        'PAYSTACK_SECRET_KEY: a live key may only be used in production',
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
    paystack: {
      secretKey: env.PAYSTACK_SECRET_KEY ?? '',
      baseUrl: env.PAYSTACK_BASE_URL.replace(/\/+$/, ''),
      timeoutMs: env.PAYSTACK_TIMEOUT_MS,
    },
  };
});

export type PaymentsConfig = ReturnType<typeof paymentsConfig>;
