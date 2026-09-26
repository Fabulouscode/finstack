import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { toApiAmount } from '../../common/money/money';
import { OrganizationStatus } from '../../organizations/organization.entity';
import { UserStatus } from '../../users/user.entity';
import { AdminOverview } from '../admin.service';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class AdminReasonRequestDto {
  @ApiProperty({
    description: 'Why, for the audit trail',
    example: 'Chargeback investigation #4521',
    maxLength: 500,
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

class PageQueryDto {
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
}

export class SearchUsersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Part of the email', example: 'ada@' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}

export class SearchOrganizationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Part of the name', example: 'acme' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ enum: OrganizationStatus })
  @IsOptional()
  @IsEnum(OrganizationStatus)
  status?: OrganizationStatus;
}

class BalanceTotalsDto {
  @ApiProperty({ example: 1250000 })
  available: number;

  @ApiProperty({ example: 50000 })
  pending: number;

  @ApiProperty({ example: 0 })
  reserved: number;
}

class InFlightDto {
  @ApiProperty({ example: 2 })
  count: number;

  @ApiProperty({ format: 'date-time', nullable: true })
  oldest: Date | null;
}

class AttentionDto {
  @ApiProperty({ type: InFlightDto })
  processingPayouts: InFlightDto;

  @ApiProperty({ type: InFlightDto })
  processingRefunds: InFlightDto;

  @ApiProperty({ example: 0 })
  openReconciliationItems: number;

  @ApiProperty({
    example: 0,
    description: 'Provider webhooks that exhausted their retries',
  })
  failedInboundWebhooks: number;

  @ApiProperty({ example: 0 })
  failedOutboundDeliveriesLast24h: number;

  @ApiProperty({ example: 0 })
  disabledWebhookEndpoints: number;
}

export class AdminOverviewResponseDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { active: 1520, suspended: 3 },
  })
  users: Record<string, number>;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { active: 48 },
  })
  organizations: Record<string, number>;

  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/BalanceTotalsDto' },
    description: 'Owed to wallet holders, per currency (minor units)',
  })
  walletBalances: Record<string, BalanceTotalsDto>;

  @ApiProperty({ type: AttentionDto })
  attention: AttentionDto;

  static from(overview: AdminOverview): AdminOverviewResponseDto {
    return {
      users: overview.users,
      organizations: overview.organizations,
      walletBalances: Object.fromEntries(
        Object.entries(overview.walletBalances).map(([currency, totals]) => [
          currency,
          {
            available: toApiAmount(totals.available),
            pending: toApiAmount(totals.pending),
            reserved: toApiAmount(totals.reserved),
          },
        ]),
      ),
      attention: overview.attention,
    };
  }
}

export { BalanceTotalsDto };
