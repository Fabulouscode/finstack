import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { MAX_API_AMOUNT, toApiAmount } from '../../common/money/money';
import { TransactionStatus } from '../../transactions/transaction.types';
import { RefundView } from '../refunds.service';

export class CreateRefundRequestDto {
  @ApiPropertyOptional({
    description:
      'Amount to return to the customer, in minor units of the PAYMENT currency. Omit to refund everything still refundable.',
    example: 775000,
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsInt()
  @IsPositive()
  @Max(MAX_API_AMOUNT)
  amount?: number;

  @ApiProperty({ example: 'Customer requested cancellation', maxLength: 500 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class RefundWalletDebitDto {
  @ApiProperty({
    description: 'Minor units of the wallet currency',
    example: 495,
  })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;
}

export class RefundResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'rfd_4c2f8a1e9b7d3c5e0a6f' })
  reference: string;

  @ApiProperty({ format: 'uuid' })
  paymentId: string;

  @ApiProperty({
    format: 'uuid',
    description: 'The refund transaction (type `refund`)',
  })
  transactionId: string;

  @ApiProperty({
    enum: [
      TransactionStatus.Processing,
      TransactionStatus.Successful,
      TransactionStatus.Failed,
    ],
    example: TransactionStatus.Successful,
  })
  status: TransactionStatus;

  @ApiProperty({
    description: 'Returned to the customer, payment currency minor units',
    example: 775000,
  })
  amount: number;

  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({
    type: RefundWalletDebitDto,
    description: 'Taken from the wallet (held until the refund settles)',
  })
  walletDebit: RefundWalletDebitDto;

  @ApiProperty({ example: 'paystack' })
  provider: string;

  @ApiProperty({ nullable: true, example: '3018284' })
  providerRefundReference: string | null;

  @ApiProperty({ example: 'Customer requested cancellation' })
  reason: string;

  @ApiProperty({ nullable: true, example: null })
  failureCode: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt: Date | null;

  static from({ refund, transaction }: RefundView): RefundResponseDto {
    return {
      id: refund.id,
      reference: refund.reference,
      paymentId: refund.paymentId,
      transactionId: transaction.id,
      status: transaction.status,
      amount: toApiAmount(refund.amount),
      currency: refund.currency,
      walletDebit: {
        amount: toApiAmount(refund.walletDebitAmount),
        currency: refund.walletCurrency,
      },
      provider: refund.provider,
      providerRefundReference: refund.providerRefundReference,
      reason: refund.reason,
      failureCode: transaction.failureCode,
      createdAt: refund.createdAt,
      completedAt: transaction.completedAt,
    };
  }
}
