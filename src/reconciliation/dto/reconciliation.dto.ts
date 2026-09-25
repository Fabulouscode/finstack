import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { KNOWN_PAYMENT_PROVIDERS } from '../../config/payments.config';
import {
  ReconciliationIssue,
  ReconciliationItem,
  ReconciliationItemKind,
  ReconciliationItemStatus,
} from '../reconciliation-item.entity';
import {
  ReconciliationRun,
  ReconciliationRunStatus,
  ReconciliationTrigger,
} from '../reconciliation-run.entity';

export class StartReconciliationRequestDto {
  @ApiPropertyOptional({
    enum: KNOWN_PAYMENT_PROVIDERS,
    description: 'Omit to check the ledger itself',
    example: 'paystack',
  })
  @IsOptional()
  @IsIn(KNOWN_PAYMENT_PROVIDERS)
  provider?: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-24T00:00:00Z' })
  @Type(() => Date)
  @IsDate()
  from: Date;

  @ApiProperty({
    format: 'date-time',
    description: 'Exclusive; at most 31 days after `from`, not in the future',
    example: '2026-09-25T00:00:00Z',
  })
  @Type(() => Date)
  @IsDate()
  to: Date;
}

export class ResolveReconciliationItemRequestDto {
  @ApiProperty({
    description: 'What was done about it, for the audit trail',
    example: 'Credited manually after confirming the bank settlement',
    maxLength: 500,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  note: string;
}

export class ListReconciliationRunsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class ListReconciliationItemsQueryDto extends ListReconciliationRunsQueryDto {
  @ApiPropertyOptional({ enum: ReconciliationItemStatus })
  @IsOptional()
  @IsEnum(ReconciliationItemStatus)
  status?: ReconciliationItemStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  runId?: string;

  @ApiPropertyOptional({ description: 'Opaque cursor from `nextCursor`' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

export class ReconciliationRunResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    nullable: true,
    description: 'Null for ledger checks',
    example: 'paystack',
  })
  provider: string | null;

  @ApiProperty({ format: 'date-time' })
  periodStart: Date;

  @ApiProperty({ format: 'date-time' })
  periodEnd: Date;

  @ApiProperty({ enum: ReconciliationRunStatus })
  status: ReconciliationRunStatus;

  @ApiProperty({ enum: ReconciliationTrigger })
  trigger: ReconciliationTrigger;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: {
      paymentsChecked: 120,
      payoutsChecked: 8,
      issues: 1,
      autoResolved: 2,
      byIssue: { late_settlement: 2, not_credited: 1 },
    },
  })
  summary: Record<string, unknown>;

  @ApiProperty({ nullable: true })
  error: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time', nullable: true })
  finishedAt: Date | null;

  static from(run: ReconciliationRun): ReconciliationRunResponseDto {
    return {
      id: run.id,
      provider: run.provider,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      status: run.status,
      trigger: run.trigger,
      summary: { ...run.summary },
      error: run.error,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
    };
  }
}

export class ReconciliationItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  runId: string;

  @ApiProperty({ enum: ReconciliationItemKind })
  kind: ReconciliationItemKind;

  @ApiProperty({ enum: ReconciliationIssue })
  issue: ReconciliationIssue;

  @ApiProperty({ enum: ReconciliationItemStatus })
  status: ReconciliationItemStatus;

  @ApiProperty({ nullable: true, example: 'trx_9f2c4e1a7b3d5c8e6f0a' })
  reference: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  targetId: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  finstack: Record<string, unknown> | null;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  provider: Record<string, unknown> | null;

  @ApiProperty({ nullable: true })
  resolutionNote: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  resolvedAt: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  static from(item: ReconciliationItem): ReconciliationItemResponseDto {
    return {
      id: item.id,
      runId: item.runId,
      kind: item.kind,
      issue: item.issue,
      status: item.status,
      reference: item.reference,
      targetId: item.targetId,
      finstack: item.finstack,
      provider: item.provider,
      resolutionNote: item.resolutionNote,
      resolvedAt: item.resolvedAt,
      createdAt: item.createdAt,
    };
  }
}

export class ReconciliationItemsPageDto {
  @ApiProperty({ type: [ReconciliationItemResponseDto] })
  data: ReconciliationItemResponseDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}
