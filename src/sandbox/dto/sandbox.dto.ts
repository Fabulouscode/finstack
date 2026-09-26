import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsPositive, Max } from 'class-validator';
import { SUPPORTED_CURRENCIES } from '../../common/money/currency';
import type { CurrencyCode } from '../../common/money/currency';
import { MAX_API_AMOUNT } from '../../common/money/money';

export class FundWalletRequestDto {
  @ApiProperty({ description: 'Minor units', example: 100000 })
  @IsInt()
  @IsPositive()
  @Max(MAX_API_AMOUNT)
  amount: number;

  @ApiPropertyOptional({
    enum: SUPPORTED_CURRENCIES,
    description: "Defaults to the primary wallet's currency",
  })
  @IsOptional()
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: CurrencyCode;
}

export class CompletePaymentRequestDto {
  @ApiProperty({ enum: ['successful', 'failed'], example: 'successful' })
  @IsIn(['successful', 'failed'])
  outcome: 'successful' | 'failed';

  @ApiPropertyOptional({
    description:
      'Simulate the provider collecting a different amount (tests amount-mismatch handling)',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(MAX_API_AMOUNT)
  collectedAmount?: number;
}

export class CompletePayoutRequestDto {
  @ApiProperty({
    enum: ['successful', 'failed', 'reversed'],
    description: '`reversed`: the bank returns a completed payout',
    example: 'successful',
  })
  @IsIn(['successful', 'failed', 'reversed'])
  outcome: 'successful' | 'failed' | 'reversed';
}
