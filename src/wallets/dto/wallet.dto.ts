import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SUPPORTED_CURRENCIES } from '../../common/money/currency';
import type { CurrencyCode } from '../../common/money/currency';
import { toApiAmount } from '../../common/money/money';
import { AccountEntry } from '../../ledger/ledger.service';
import { EntryDirection } from '../../ledger/ledger.types';
import { WalletStatus } from '../wallet.entity';
import { WalletWithBalances } from '../wallets.service';

// ---- Requests -----------------------------------------------------------------

export class CreateWalletRequestDto {
  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'NGN' })
  @IsIn(SUPPORTED_CURRENCIES)
  currency: CurrencyCode;
}

export class ListWalletEntriesQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({
    description: 'Opaque cursor from `nextCursor` of the previous page',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

// ---- Responses ----------------------------------------------------------------

export class WalletBalancesDto {
  @ApiProperty({
    description: 'Spendable balance in minor units (e.g. kobo)',
    example: 1500000,
  })
  available: number;

  @ApiProperty({
    description: 'Incoming funds not yet settled, in minor units',
    example: 0,
  })
  pending: number;

  @ApiProperty({
    description: 'Funds on hold, in minor units',
    example: 250000,
  })
  reserved: number;
}

export class WalletResponseDto {
  @ApiProperty({
    format: 'uuid',
    example: '6a1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  })
  id: string;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'NGN' })
  currency: string;

  @ApiProperty({ enum: WalletStatus, example: WalletStatus.Active })
  status: WalletStatus;

  @ApiProperty({ type: WalletBalancesDto })
  balances: WalletBalancesDto;

  @ApiProperty({ format: 'date-time', example: '2026-09-24T10:00:00.000Z' })
  createdAt: Date;

  static from({ wallet, balances }: WalletWithBalances): WalletResponseDto {
    return {
      id: wallet.id,
      currency: wallet.currency,
      status: wallet.status,
      balances: {
        available: toApiAmount(balances.available),
        pending: toApiAmount(balances.pending),
        reserved: toApiAmount(balances.reserved),
      },
      createdAt: wallet.createdAt,
    };
  }
}

export class WalletEntryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Ledger transaction this entry belongs to',
  })
  transactionId: string;

  @ApiProperty({ example: 'dep_01HZX3' })
  reference: string;

  @ApiProperty({ example: 'Card top-up' })
  description: string;

  @ApiProperty({
    enum: ['credit', 'debit'],
    description: '`credit` adds to the wallet, `debit` takes from it',
    example: 'credit',
  })
  type: 'credit' | 'debit';

  @ApiProperty({ description: 'Minor units, always positive', example: 500000 })
  amount: number;

  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  static from(entry: AccountEntry): WalletEntryDto {
    return {
      id: entry.id,
      transactionId: entry.transactionId,
      reference: entry.reference,
      description: entry.description,
      // Wallet balances are liabilities: a ledger credit increases them.
      type: entry.direction === EntryDirection.Credit ? 'credit' : 'debit',
      amount: toApiAmount(entry.amount),
      currency: entry.currency,
      createdAt: entry.createdAt,
    };
  }
}

export class WalletEntriesPageDto {
  @ApiProperty({ type: [WalletEntryDto] })
  data: WalletEntryDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Pass as `cursor` to get the next (older) page. `null` on the last page.',
  })
  nextCursor: string | null;
}
