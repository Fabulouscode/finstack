import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AuditActorType, AuditLog } from '../audit-log.entity';

export class ListAuditLogsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @ApiPropertyOptional({ description: 'Opaque cursor from `nextCursor`' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @ApiPropertyOptional({ example: 'member.role_changed' })
  @IsOptional()
  @Matches(/^[a-z_]+\.[a-z_]+$/)
  action?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'User or API key id' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({ example: 'payment' })
  @IsOptional()
  @Matches(/^[a-z_]{1,50}$/)
  targetType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetId?: string;
}

export class AdminListAuditLogsQueryDto extends ListAuditLogsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}

export class AuditActorDto {
  @ApiProperty({ enum: AuditActorType, example: AuditActorType.User })
  type: AuditActorType;

  @ApiProperty({ format: 'uuid', nullable: true })
  id: string | null;
}

export class AuditLogResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'member.role_changed' })
  action: string;

  @ApiProperty({ type: AuditActorDto })
  actor: AuditActorDto;

  @ApiProperty({ format: 'uuid', nullable: true })
  organizationId: string | null;

  @ApiProperty({ example: 'membership' })
  targetType: string;

  @ApiProperty()
  targetId: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { from: 'member', to: 'admin' },
  })
  metadata: Record<string, unknown>;

  @ApiProperty({ nullable: true })
  requestId: string | null;

  @ApiProperty({ nullable: true, example: '203.0.113.7' })
  ipAddress: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  static from(log: AuditLog): AuditLogResponseDto {
    return {
      id: log.id,
      action: log.action,
      actor: { type: log.actorType, id: log.actorId },
      organizationId: log.organizationId,
      targetType: log.targetType,
      targetId: log.targetId,
      metadata: log.metadata,
      requestId: log.requestId,
      ipAddress: log.ipAddress,
      createdAt: log.createdAt,
    };
  }
}

export class AuditLogsPageDto {
  @ApiProperty({ type: [AuditLogResponseDto] })
  data: AuditLogResponseDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}
