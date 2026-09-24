import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsPositive,
  Matches,
  Max,
  ValidateIf,
} from 'class-validator';
import { SUPPORTED_CURRENCIES } from '../../common/money/currency';
import type { CurrencyCode } from '../../common/money/currency';
import { MAX_API_AMOUNT, toApiAmount } from '../../common/money/money';
import { FxQuote } from '../fx-quote.entity';
import { FxRate } from '../fx-rate.entity';
import { formatRate, parseRate } from '../fx-math';

// Positive decimal: at least one non-zero digit, up to 14 integer and 10 fractional digits.
const RATE_STRING = /^(?=.*[1-9])\d{1,14}(\.\d{1,10})?$/;

// ---- Requests -----------------------------------------------------------------

export class SetFxRateRequestDto {
  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'USD' })
  @IsIn(SUPPORTED_CURRENCIES)
  base: CurrencyCode;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'NGN' })
  @IsIn(SUPPORTED_CURRENCIES)
  quote: CurrencyCode;

  @ApiProperty({
    description:
      'Units of `quote` per 1 `base`, as a decimal string (up to 10 decimal places). Strings avoid floating-point rounding.',
    example: '1550.25',
  })
  @Matches(RATE_STRING, { message: 'rate must be a positive decimal string' })
  rate: string;
}

export class CreateFxQuoteRequestDto {
  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'NGN' })
  @IsIn(SUPPORTED_CURRENCIES)
  sourceCurrency: CurrencyCode;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'USD' })
  @IsIn(SUPPORTED_CURRENCIES)
  targetCurrency: CurrencyCode;

  @ApiPropertyOptional({
    description:
      'Amount to pay, in source minor units. Provide exactly one of `sourceAmount` or `targetAmount`.',
    example: 1550000,
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsInt()
  @IsPositive()
  @Max(MAX_API_AMOUNT)
  sourceAmount?: number;

  @ApiPropertyOptional({
    description: 'Amount to receive, in target minor units.',
    example: 1000,
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsInt()
  @IsPositive()
  @Max(MAX_API_AMOUNT)
  targetAmount?: number;
}

// ---- Responses ----------------------------------------------------------------

export class FxRateResponseDto {
  @ApiProperty({ example: 'USD' })
  base: string;

  @ApiProperty({ example: 'NGN' })
  quote: string;

  @ApiProperty({
    description: 'Units of `quote` per 1 `base`',
    example: '1550.25',
  })
  rate: string;

  @ApiProperty({ example: 'admin' })
  source: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;

  static from(rate: FxRate): FxRateResponseDto {
    return {
      base: rate.baseCurrency,
      quote: rate.quoteCurrency,
      rate: formatRate(parseRate(rate.rate)),
      source: rate.source,
      updatedAt: rate.createdAt,
    };
  }
}

export class FxQuoteResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'NGN' })
  sourceCurrency: string;

  @ApiProperty({
    description: 'Amount charged, in source minor units',
    example: 1550000,
  })
  sourceAmount: number;

  @ApiProperty({ example: 'USD' })
  targetCurrency: string;

  @ApiProperty({
    description: 'Amount credited after the spread, in target minor units',
    example: 990,
  })
  targetAmount: number;

  @ApiProperty({
    description: 'Mid rate used: units of `rateQuote` per 1 `rateBase`',
    example: '1550',
  })
  rate: string;

  @ApiProperty({ example: 'USD' })
  rateBase: string;

  @ApiProperty({ example: 'NGN' })
  rateQuote: string;

  @ApiProperty({ description: 'Platform margin in basis points', example: 100 })
  spreadBps: number;

  @ApiProperty({ enum: ['open', 'expired', 'used'], example: 'open' })
  status: 'open' | 'expired' | 'used';

  @ApiProperty({ format: 'date-time' })
  expiresAt: Date;

  static from(quote: FxQuote, now = Date.now()): FxQuoteResponseDto {
    return {
      id: quote.id,
      sourceCurrency: quote.sourceCurrency,
      sourceAmount: toApiAmount(quote.sourceAmount),
      targetCurrency: quote.targetCurrency,
      targetAmount: toApiAmount(quote.targetAmount),
      rate: formatRate(parseRate(quote.rate)),
      rateBase: quote.rateBaseCurrency,
      rateQuote: quote.rateQuoteCurrency,
      spreadBps: quote.spreadBps,
      status: quote.consumedAt
        ? 'used'
        : quote.expiresAt.getTime() <= now
          ? 'expired'
          : 'open',
      expiresAt: quote.expiresAt,
    };
  }
}
