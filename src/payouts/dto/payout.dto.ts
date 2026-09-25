import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SUPPORTED_CURRENCIES } from '../../common/money/currency';
import type { CurrencyCode } from '../../common/money/currency';
import { MAX_API_AMOUNT, toApiAmount } from '../../common/money/money';
import { KNOWN_PAYMENT_PROVIDERS } from '../../config/payments.config';
import { TransactionStatus } from '../../transactions/transaction.types';
import { PayoutDestination } from '../payout-destination.entity';
import { PayoutView } from '../payouts.service';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreatePayoutDestinationRequestDto {
  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'NGN' })
  @IsIn(SUPPORTED_CURRENCIES)
  currency: CurrencyCode;

  @ApiProperty({ description: "The provider's bank code", example: '058' })
  @Transform(trim)
  @Matches(/^[0-9A-Za-z-]{2,20}$/)
  bankCode: string;

  @ApiProperty({
    example: '0123456789',
    description: 'Sent to the provider; only the last 4 digits are stored',
  })
  @Transform(trim)
  @Matches(/^[0-9]{6,20}$/)
  accountNumber: string;

  @ApiPropertyOptional({
    description:
      "The account holder's name. Ignored where the provider verifies it (e.g. Nigerian accounts).",
    example: 'Ada Lovelace',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  accountName?: string;

  @ApiPropertyOptional({ enum: KNOWN_PAYMENT_PROVIDERS, example: 'paystack' })
  @IsOptional()
  @IsIn(KNOWN_PAYMENT_PROVIDERS)
  provider?: string;

  @ApiPropertyOptional({ example: 'Main account', maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  label?: string;
}

export class PayoutDestinationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'paystack' })
  provider: string;

  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ example: '058' })
  bankCode: string;

  @ApiProperty({ nullable: true, example: 'Guaranty Trust Bank' })
  bankName: string | null;

  @ApiProperty({ example: 'ADA LOVELACE' })
  accountName: string;

  @ApiProperty({ example: '6789' })
  accountNumberLast4: string;

  @ApiProperty({ nullable: true, example: 'Main account' })
  label: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  static from(destination: PayoutDestination): PayoutDestinationResponseDto {
    return {
      id: destination.id,
      provider: destination.provider,
      currency: destination.currency,
      bankCode: destination.bankCode,
      bankName: destination.bankName,
      accountName: destination.accountName,
      accountNumberLast4: destination.accountNumberLast4,
      label: destination.label,
      createdAt: destination.createdAt,
    };
  }
}

export class CreatePayoutRequestDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  destinationId: string;

  @ApiProperty({
    description: "Amount to send, in minor units of the wallet's currency",
    example: 500000,
  })
  @IsInt()
  @IsPositive()
  @Max(MAX_API_AMOUNT)
  amount: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      "Wallet to pay out from. Defaults to your wallet in the destination's currency.",
  })
  @IsOptional()
  @IsUUID()
  walletId?: string;

  @ApiPropertyOptional({
    example: 'September withdrawal',
    maxLength: 100,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  narration?: string;
}

export class PayoutResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'pyt_9f2c4e1a7b3d5c8e6f0a' })
  reference: string;

  @ApiProperty({ format: 'uuid' })
  transactionId: string;

  @ApiProperty({
    enum: [
      TransactionStatus.Processing,
      TransactionStatus.Successful,
      TransactionStatus.Failed,
      TransactionStatus.Reversed,
    ],
    example: TransactionStatus.Processing,
  })
  status: TransactionStatus;

  @ApiProperty({ description: 'Minor units', example: 500000 })
  amount: number;

  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ format: 'uuid' })
  walletId: string;

  @ApiProperty({ type: PayoutDestinationResponseDto })
  destination: PayoutDestinationResponseDto;

  @ApiProperty({ example: 'paystack' })
  provider: string;

  @ApiProperty({ nullable: true, example: 'TRF_1ptvuv321ahaa7q' })
  providerReference: string | null;

  @ApiProperty({ nullable: true, example: null })
  failureCode: string | null;

  @ApiProperty({ nullable: true, example: null })
  failureReason: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt: Date | null;

  static from({
    payout,
    transaction,
    destination,
  }: PayoutView): PayoutResponseDto {
    return {
      id: payout.id,
      reference: payout.reference,
      transactionId: transaction.id,
      status: transaction.status,
      amount: toApiAmount(payout.amount),
      currency: payout.currency,
      walletId: payout.walletId,
      destination: PayoutDestinationResponseDto.from(destination),
      provider: payout.provider,
      providerReference: payout.providerReference,
      failureCode: transaction.failureCode,
      failureReason: transaction.failureReason,
      createdAt: payout.createdAt,
      completedAt: transaction.completedAt,
    };
  }
}
