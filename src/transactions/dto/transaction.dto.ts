import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { SUPPORTED_CURRENCIES } from '../../common/money/currency';
import type { CurrencyCode } from '../../common/money/currency';
import { MAX_API_AMOUNT, toApiAmount } from '../../common/money/money';
import { Transaction } from '../transaction.entity';
import { TransactionStatus, TransactionType } from '../transaction.types';

// ---- Requests -----------------------------------------------------------------

export class CreateTransferRequestDto {
  @ApiProperty({ example: 'bob@example.com' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(320)
  recipientEmail: string;

  @ApiProperty({
    description: 'Amount in minor units of the currency (e.g. cents)',
    example: 2500,
  })
  @IsInt()
  @IsPositive()
  @Max(MAX_API_AMOUNT)
  amount: number;

  @ApiPropertyOptional({
    enum: SUPPORTED_CURRENCIES,
    description: 'Defaults to the currency of your primary wallet',
    example: 'USD',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: CurrencyCode;

  @ApiPropertyOptional({ example: 'Dinner split', maxLength: 500 })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class ListTransactionsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ description: 'Opaque cursor from `nextCursor`' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

// ---- Responses ----------------------------------------------------------------

export class TransactionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'trx_9f2c4e1a7b3d5c8e6f0a' })
  reference: string;

  @ApiProperty({ enum: TransactionType, example: TransactionType.Transfer })
  type: TransactionType;

  @ApiProperty({
    enum: TransactionStatus,
    example: TransactionStatus.Successful,
  })
  status: TransactionStatus;

  @ApiProperty({
    enum: ['outgoing', 'incoming'],
    description: 'Relative to the current user',
    example: 'outgoing',
  })
  direction: 'outgoing' | 'incoming';

  @ApiProperty({ description: 'Minor units', example: 2500 })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'Your wallet involved',
  })
  walletId: string | null;

  @ApiProperty({ nullable: true, example: 'Dinner split' })
  description: string | null;

  @ApiProperty({ nullable: true, example: null })
  failureCode: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt: Date | null;

  static from(
    transaction: Transaction,
    viewerId: string,
  ): TransactionResponseDto {
    const outgoing = transaction.userId === viewerId;
    return {
      id: transaction.id,
      reference: transaction.reference,
      type: transaction.type,
      status: transaction.status,
      direction: outgoing ? 'outgoing' : 'incoming',
      amount: toApiAmount(transaction.amount),
      currency: transaction.currency,
      walletId: outgoing
        ? transaction.sourceWalletId
        : transaction.destinationWalletId,
      description: transaction.description,
      failureCode: transaction.failureCode,
      createdAt: transaction.createdAt,
      completedAt: transaction.completedAt,
    };
  }
}

/**
 * An organization's view: money into its wallets (payments) is incoming,
 * money out (refunds) is outgoing.
 */
export function organizationTransactionDto(
  transaction: Transaction,
): TransactionResponseDto {
  const outgoing = transaction.sourceWalletId !== null;
  return {
    id: transaction.id,
    reference: transaction.reference,
    type: transaction.type,
    status: transaction.status,
    direction: outgoing ? 'outgoing' : 'incoming',
    amount: toApiAmount(transaction.amount),
    currency: transaction.currency,
    walletId: outgoing
      ? transaction.sourceWalletId
      : transaction.destinationWalletId,
    description: transaction.description,
    failureCode: transaction.failureCode,
    createdAt: transaction.createdAt,
    completedAt: transaction.completedAt,
  };
}

export class TransactionsPageDto {
  @ApiProperty({ type: [TransactionResponseDto] })
  data: TransactionResponseDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}
