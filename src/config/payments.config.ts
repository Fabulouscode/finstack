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
import { SUPPORTED_CURRENCIES } from '../common/money/currency';
import { ConfigValidationError, validateConfig } from './validate-config';

export const KNOWN_PAYMENT_PROVIDERS = ['mock', 'paystack', 'stripe'] as const;
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

  /** Stripe secret key: `sk_test_...` or `sk_live_...` (restricted `rk_` keys too). */
  @IsOptional()
  @Matches(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, {
    message: 'STRIPE_SECRET_KEY must look like sk_test_... or sk_live_...',
  })
  STRIPE_SECRET_KEY?: string;

  /** Signing secret of the webhook endpoint (`whsec_...`). */
  @IsOptional()
  @Matches(/^whsec_[A-Za-z0-9+/=]+$/, {
    message: 'STRIPE_WEBHOOK_SECRET must look like whsec_...',
  })
  STRIPE_WEBHOOK_SECRET?: string;

  @IsUrl({
    require_tld: false,
    protocols: ['https', 'http'],
    require_protocol: true,
  })
  STRIPE_BASE_URL: string = 'https://api.stripe.com';

  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  @Max(60_000)
  STRIPE_TIMEOUT_MS: number = 10_000;

  /** Webhooks signed longer ago than this are rejected (replay protection). */
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(3_600)
  STRIPE_WEBHOOK_TOLERANCE_SECONDS: number = 300;

  /** Where Stripe Checkout returns the customer when no callbackUrl is given. */
  @IsOptional()
  @IsUrl({
    require_tld: false,
    protocols: ['https', 'http'],
    require_protocol: true,
  })
  STRIPE_SUCCESS_URL?: string;

  @IsOptional()
  @IsUrl({
    require_tld: false,
    protocols: ['https', 'http'],
    require_protocol: true,
  })
  STRIPE_CANCEL_URL?: string;

  /**
   * Currencies that must always use a specific provider, e.g.
   * `USD:stripe,NGN:paystack`. Other currencies use the requested or
   * default provider.
   */
  @IsOptional()
  @Matches(/^([A-Z]{3}:[a-z]+)(,[A-Z]{3}:[a-z]+)*$/, {
    message: 'PAYMENT_CURRENCY_ROUTES must look like USD:stripe,NGN:paystack',
  })
  PAYMENT_CURRENCY_ROUTES?: string;
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
  const currencyRoutes: Record<string, PaymentProviderName> = {};
  for (const route of (env.PAYMENT_CURRENCY_ROUTES ?? '')
    .split(',')
    .filter(Boolean)) {
    const [currency = '', provider = ''] = route.split(':');
    if (!(SUPPORTED_CURRENCIES as string[]).includes(currency)) {
      violations.push(
        `PAYMENT_CURRENCY_ROUTES: unsupported currency ${currency}`,
      );
    } else if (!(enabled as string[]).includes(provider)) {
      violations.push(
        `PAYMENT_CURRENCY_ROUTES: ${currency} routes to ${provider}, which is not in PAYMENT_PROVIDERS`,
      );
    } else if (currencyRoutes[currency]) {
      violations.push(`PAYMENT_CURRENCY_ROUTES: ${currency} is routed twice`);
    } else {
      currencyRoutes[currency] = provider as PaymentProviderName;
    }
  }

  if (enabled.includes('stripe')) {
    const key = env.STRIPE_SECRET_KEY;
    const production = process.env.NODE_ENV === 'production';
    if (!key) {
      violations.push('STRIPE_SECRET_KEY is required when Stripe is enabled');
    } else if (production && key.includes('_test_')) {
      violations.push(
        'STRIPE_SECRET_KEY: a test key must not be used in production',
      );
    } else if (!production && key.includes('_live_')) {
      violations.push(
        'STRIPE_SECRET_KEY: a live key may only be used in production',
      );
    }
    if (!env.STRIPE_WEBHOOK_SECRET) {
      violations.push(
        'STRIPE_WEBHOOK_SECRET is required when Stripe is enabled',
      );
    }
    if (!env.STRIPE_SUCCESS_URL || !env.STRIPE_CANCEL_URL) {
      violations.push(
        'STRIPE_SUCCESS_URL and STRIPE_CANCEL_URL are required when Stripe is enabled',
      );
    }
  }
  if (violations.length > 0) {
    throw new ConfigValidationError('payments', violations);
  }

  return {
    enabledProviders: enabled,
    defaultProvider: defaultProvider as PaymentProviderName,
    currencyRoutes,
    mock: { webhookSecret: env.MOCK_PROVIDER_WEBHOOK_SECRET ?? '' },
    paystack: {
      secretKey: env.PAYSTACK_SECRET_KEY ?? '',
      baseUrl: env.PAYSTACK_BASE_URL.replace(/\/+$/, ''),
      timeoutMs: env.PAYSTACK_TIMEOUT_MS,
    },
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY ?? '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
      baseUrl: env.STRIPE_BASE_URL.replace(/\/+$/, ''),
      timeoutMs: env.STRIPE_TIMEOUT_MS,
      webhookToleranceSeconds: env.STRIPE_WEBHOOK_TOLERANCE_SECONDS,
      successUrl: env.STRIPE_SUCCESS_URL ?? '',
      cancelUrl: env.STRIPE_CANCEL_URL ?? '',
    },
  };
});

export type PaymentsConfig = ReturnType<typeof paymentsConfig>;
