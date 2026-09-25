import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsPositive,
  IsUrl,
  Max,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { SUPPORTED_CURRENCIES } from '../../common/money/currency';
import type { CurrencyCode } from '../../common/money/currency';
import { MAX_API_AMOUNT, toApiAmount } from '../../common/money/money';
import { KNOWN_PAYMENT_PROVIDERS } from '../../config/payments.config';
import { formatRate, parseRate } from '../../fx/fx-math';
import { TransactionStatus } from '../../transactions/transaction.types';
import { PaymentView } from '../payments.service';

export class InitializePaymentRequestDto {
  @ApiProperty({
    description: 'Amount to charge, in minor units of `currency`',
    example: 1550000,
  })
  @IsInt()
  @IsPositive()
  @Max(MAX_API_AMOUNT)
  amount: number;

  @ApiProperty({
    enum: SUPPORTED_CURRENCIES,
    description:
      'Currency to charge. If you have no wallet in it, the payment is converted into your primary wallet at a locked quote.',
    example: 'NGN',
  })
  @IsIn(SUPPORTED_CURRENCIES)
  currency: CurrencyCode;

  @ApiPropertyOptional({ enum: KNOWN_PAYMENT_PROVIDERS, example: 'mock' })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsIn(KNOWN_PAYMENT_PROVIDERS)
  provider?: string;

  @ApiPropertyOptional({
    description: 'Where the provider sends the customer after checkout',
    example: 'https://app.example.com/payments/complete',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true })
  @MaxLength(2048)
  callbackUrl?: string;
}

export class InitializeOrganizationPaymentRequestDto extends InitializePaymentRequestDto {
  @ApiProperty({
    description:
      "The paying customer's email, passed to the provider's checkout",
    example: 'customer@example.com',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(320)
  customerEmail: string;
}

export class PaymentCreditDto {
  @ApiProperty({
    description: 'Amount the wallet receives, in its minor units',
    example: 990,
  })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({
    description: 'Mid rate: units of `rateQuote` per 1 `rateBase`',
    example: '1550',
  })
  rate: string;

  @ApiProperty({ example: 'USD' })
  rateBase: string;

  @ApiProperty({ example: 'NGN' })
  rateQuote: string;

  @ApiProperty({ example: 100 })
  spreadBps: number;

  @ApiProperty({
    format: 'date-time',
    description:
      'Pay before this to get this amount; later payments are re-quoted.',
  })
  quoteExpiresAt: Date;
}

export class PaymentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description: 'Transaction reference',
    example: 'trx_9f2c4e1a7b3d5c8e6f0a',
  })
  reference: string;

  @ApiProperty({ format: 'uuid' })
  transactionId: string;

  @ApiProperty({ enum: TransactionStatus, example: TransactionStatus.Pending })
  status: TransactionStatus;

  @ApiProperty({ example: 'mock' })
  provider: string;

  @ApiProperty({ nullable: true, example: 'mock_4f9a2c1e7b3d5a8c' })
  providerReference: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Send the customer here to pay',
    example: 'https://checkout.mock-provider.test/pay/mock_4f9a2c1e7b3d5a8c',
  })
  authorizationUrl: string | null;

  @ApiProperty({ description: 'Charged amount, minor units', example: 1550000 })
  amount: number;

  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ format: 'uuid', description: 'Wallet to be credited' })
  walletId: string;

  @ApiProperty({
    type: PaymentCreditDto,
    nullable: true,
    description:
      'Present when the payment is converted into the wallet currency',
  })
  conversion: PaymentCreditDto | null;

  @ApiProperty({ nullable: true, example: null })
  failureCode: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt: Date | null;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description:
      'When the credited money is (or becomes) spendable. Later than `completedAt` under a settlement hold (PAYMENT_SETTLEMENT_DELAY_SECONDS); null until credited.',
  })
  fundsAvailableAt: Date | null;

  @ApiProperty({
    description:
      "Still in the wallet's pending balance from this payment (wallet currency, minor units)",
    example: 0,
  })
  heldAmount: number;

  static from({
    payment,
    transaction,
    quote,
  }: PaymentView): PaymentResponseDto {
    return {
      id: payment.id,
      reference: transaction.reference,
      transactionId: transaction.id,
      status: transaction.status,
      provider: payment.provider,
      providerReference: payment.providerReference,
      authorizationUrl: payment.authorizationUrl,
      amount: toApiAmount(payment.amount),
      currency: payment.currency,
      walletId: payment.walletId,
      conversion: quote
        ? {
            amount: toApiAmount(quote.targetAmount),
            currency: quote.targetCurrency,
            rate: formatRate(parseRate(quote.rate)),
            rateBase: quote.rateBaseCurrency,
            rateQuote: quote.rateQuoteCurrency,
            spreadBps: quote.spreadBps,
            quoteExpiresAt: quote.expiresAt,
          }
        : null,
      failureCode: transaction.failureCode,
      createdAt: payment.createdAt,
      completedAt: transaction.completedAt,
      fundsAvailableAt: payment.fundsAvailableAt,
      heldAmount: toApiAmount(payment.pendingAmount),
    };
  }
}
