import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { KNOWN_PAYMENT_PROVIDERS } from '../../config/payments.config';
import { TransactionStatus } from '../../transactions/transaction.types';
import { decodeCursor } from './cursor';
import { PageOptions } from './keyset-page';

/** What the admin money lists can be filtered by. */
export interface AdminMoneyFilter {
  status?: TransactionStatus;
  provider?: string;
  currency?: string;
  userId?: string;
  organizationId?: string;
  paymentId?: string;
}

/** Filters and paging shared by the admin money lists. */
export class AdminMoneyListQueryDto {
  @ApiPropertyOptional({ enum: TransactionStatus })
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;

  @ApiPropertyOptional({ enum: KNOWN_PAYMENT_PROVIDERS })
  @IsOptional()
  @IsIn(KNOWN_PAYMENT_PROVIDERS)
  provider?: string;

  @ApiPropertyOptional({ example: 'NGN' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO code like NGN' })
  currency?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
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

  page(): PageOptions {
    return {
      limit: this.limit,
      before: this.cursor ? decodeCursor(this.cursor) : undefined,
    };
  }
}

/** Plus the owner: a user or an organization. */
export class AdminOwnedMoneyListQueryDto extends AdminMoneyListQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}
