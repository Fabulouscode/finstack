import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { SUPPORTED_CURRENCIES } from '../../common/money/currency';
import type { CurrencyCode } from '../../common/money/currency';
import { MAX_API_AMOUNT, toApiAmount } from '../../common/money/money';
import { toBoolean } from '../../config/env-transformers';
import { LimitOperation, LimitRule } from '../limit-rule.entity';
import { LimitUsage } from '../limits.service';

const amount = (value: bigint | null): number | null =>
  value === null ? null : toApiAmount(value);

export class SetLimitRuleRequestDto {
  @ApiProperty({ enum: LimitOperation, example: LimitOperation.Payout })
  @IsEnum(LimitOperation)
  operation: LimitOperation;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'USD' })
  @IsIn(SUPPORTED_CURRENCIES)
  currency: CurrencyCode;

  @ApiPropertyOptional({
    format: 'uuid',
    description: "An organization's own limits; omit for the platform default",
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    description: 'Minor units; omit for no cap',
    example: 500000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_API_AMOUNT)
  maxPerTransaction?: number;

  @ApiPropertyOptional({
    description: 'Minor units per rolling 24 hours',
    example: 1000000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_API_AMOUNT)
  maxDailyAmount?: number;

  @ApiPropertyOptional({
    description: 'Operations per rolling 24 hours',
    example: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxDailyCount?: number;

  @ApiPropertyOptional({
    description: 'Minor units per rolling 30 days',
    example: 10000000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_API_AMOUNT)
  maxMonthlyAmount?: number;
}

export class ListLimitRulesQueryDto {
  @ApiPropertyOptional({ enum: LimitOperation })
  @IsOptional()
  @IsEnum(LimitOperation)
  operation?: LimitOperation;

  @ApiPropertyOptional({ enum: SUPPORTED_CURRENCIES })
  @IsOptional()
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: CurrencyCode;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  history: boolean = false;
}

export class LimitRuleResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: LimitOperation })
  operation: LimitOperation;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  organizationId: string | null;

  @ApiProperty({ nullable: true, example: 500000 })
  maxPerTransaction: number | null;

  @ApiProperty({ nullable: true, example: 1000000 })
  maxDailyAmount: number | null;

  @ApiProperty({ nullable: true, example: 10 })
  maxDailyCount: number | null;

  @ApiProperty({ nullable: true, example: null })
  maxMonthlyAmount: number | null;

  @ApiProperty()
  active: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  static from(rule: LimitRule): LimitRuleResponseDto {
    return {
      id: rule.id,
      operation: rule.operation,
      currency: rule.currency,
      organizationId: rule.organizationId,
      maxPerTransaction: amount(rule.maxPerTransaction),
      maxDailyAmount: amount(rule.maxDailyAmount),
      maxDailyCount: rule.maxDailyCount,
      maxMonthlyAmount: amount(rule.maxMonthlyAmount),
      active: rule.supersededAt === null,
      createdAt: rule.createdAt,
    };
  }
}

export class LimitUsageResponseDto {
  @ApiProperty({ enum: LimitOperation })
  operation: LimitOperation;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ nullable: true, example: 500000 })
  maxPerTransaction: number | null;

  @ApiProperty({
    type: 'object',
    description:
      'Rolling 24 hours: limits, used and remaining (null = unlimited)',
    example: {
      maxAmount: 1000000,
      usedAmount: 250000,
      remainingAmount: 750000,
      maxCount: 10,
      usedCount: 2,
    },
    additionalProperties: true,
  })
  daily: {
    maxAmount: number | null;
    usedAmount: number;
    remainingAmount: number | null;
    maxCount: number | null;
    usedCount: number;
  };

  @ApiProperty({
    type: 'object',
    description: 'Rolling 30 days',
    example: { maxAmount: null, usedAmount: 0, remainingAmount: null },
    additionalProperties: true,
  })
  monthly: {
    maxAmount: number | null;
    usedAmount: number;
    remainingAmount: number | null;
  };

  static from({ rule, daily, monthly }: LimitUsage): LimitUsageResponseDto {
    const remaining = (max: bigint | null, used: bigint): number | null =>
      max === null ? null : toApiAmount(max > used ? max - used : 0n);
    return {
      operation: rule.operation,
      currency: rule.currency,
      maxPerTransaction: amount(rule.maxPerTransaction),
      daily: {
        maxAmount: amount(rule.maxDailyAmount),
        usedAmount: toApiAmount(daily.amount),
        remainingAmount: remaining(rule.maxDailyAmount, daily.amount),
        maxCount: rule.maxDailyCount,
        usedCount: daily.count,
      },
      monthly: {
        maxAmount: amount(rule.maxMonthlyAmount),
        usedAmount: toApiAmount(monthly.amount),
        remainingAmount: remaining(rule.maxMonthlyAmount, monthly.amount),
      },
    };
  }
}
