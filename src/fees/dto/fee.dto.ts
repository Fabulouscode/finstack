import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { SUPPORTED_CURRENCIES } from '../../common/money/currency';
import type { CurrencyCode } from '../../common/money/currency';
import { MAX_API_AMOUNT, toApiAmount } from '../../common/money/money';
import { toBoolean } from '../../config/env-transformers';
import { FeeOperation, FeeRule } from '../fee-rule.entity';

/** A fee on a transaction or quote. */
export class FeeDto {
  @ApiProperty({ description: 'Minor units', example: 150 })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  static from(amount: bigint, currency: string | null): FeeDto | null {
    return amount > 0n && currency
      ? { amount: toApiAmount(amount), currency }
      : null;
  }
}

export class FeeQuoteQueryDto {
  @ApiProperty({ enum: FeeOperation, example: FeeOperation.Payout })
  @IsEnum(FeeOperation)
  operation: FeeOperation;

  @ApiProperty({
    enum: SUPPORTED_CURRENCIES,
    description:
      "The wallet's currency (for payments: the currency credited, after any conversion)",
    example: 'USD',
  })
  @IsIn(SUPPORTED_CURRENCIES)
  currency: CurrencyCode;

  @ApiProperty({ description: 'Minor units', example: 10000 })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @Max(MAX_API_AMOUNT)
  amount: number;
}

export class FeeQuoteResponseDto {
  @ApiProperty({ enum: FeeOperation })
  operation: FeeOperation;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ example: 10000 })
  amount: number;

  @ApiProperty({ example: 150, description: '0 when free' })
  fee: number;

  @ApiProperty({
    example: 10150,
    description:
      'Payouts and transfers: what leaves the wallet (amount + fee). Payments: what the wallet receives (amount - fee).',
  })
  total: number;
}

export class SetFeeRuleRequestDto {
  @ApiProperty({ enum: FeeOperation, example: FeeOperation.Payment })
  @IsEnum(FeeOperation)
  operation: FeeOperation;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'USD' })
  @IsIn(SUPPORTED_CURRENCIES)
  currency: CurrencyCode;

  @ApiPropertyOptional({
    format: 'uuid',
    description: "An organization's own rate; omit for the platform default",
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ description: 'Minor units', default: 0, example: 30 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_API_AMOUNT)
  fixedAmount: number = 0;

  @ApiPropertyOptional({
    description: '1 bps = 0.01% (e.g. 150 = 1.5%)',
    default: 0,
    example: 150,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  percentageBps: number = 0;

  @ApiPropertyOptional({ description: 'Minor units', default: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_API_AMOUNT)
  minAmount: number = 0;

  @ApiPropertyOptional({ description: 'Minor units; omit for no cap' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_API_AMOUNT)
  maxAmount?: number;
}

export class ListFeeRulesQueryDto {
  @ApiPropertyOptional({ enum: FeeOperation })
  @IsOptional()
  @IsEnum(FeeOperation)
  operation?: FeeOperation;

  @ApiPropertyOptional({ enum: SUPPORTED_CURRENCIES })
  @IsOptional()
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: CurrencyCode;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    description: 'Include superseded and retired rules',
    default: false,
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  history: boolean = false;
}

export class FeeRuleResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: FeeOperation })
  operation: FeeOperation;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  organizationId: string | null;

  @ApiProperty({ example: 30 })
  fixedAmount: number;

  @ApiProperty({ example: 150 })
  percentageBps: number;

  @ApiProperty({ example: 0 })
  minAmount: number;

  @ApiProperty({ nullable: true, example: null })
  maxAmount: number | null;

  @ApiProperty({ description: 'False once superseded or retired' })
  active: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time', nullable: true })
  supersededAt: Date | null;

  static from(rule: FeeRule): FeeRuleResponseDto {
    return {
      id: rule.id,
      operation: rule.operation,
      currency: rule.currency,
      organizationId: rule.organizationId,
      fixedAmount: toApiAmount(rule.fixedAmount),
      percentageBps: rule.percentageBps,
      minAmount: toApiAmount(rule.minAmount),
      maxAmount: rule.maxAmount === null ? null : toApiAmount(rule.maxAmount),
      active: rule.supersededAt === null,
      createdAt: rule.createdAt,
      supersededAt: rule.supersededAt,
    };
  }
}
