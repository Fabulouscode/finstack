import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  WebhookDelivery,
  WebhookDeliveryStatus,
} from '../webhook-delivery.entity';
import { WebhookEndpoint } from '../webhook-endpoint.entity';
import { ALL_EVENTS, WEBHOOK_EVENT_TYPES } from '../webhook-event-types';

const SUBSCRIBABLE = [ALL_EVENTS, ...WEBHOOK_EVENT_TYPES];
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateWebhookEndpointRequestDto {
  @ApiProperty({ example: 'https://api.example.com/finstack/webhooks' })
  @Transform(trim)
  @IsUrl({
    protocols: ['https', 'http'],
    require_protocol: true,
    require_tld: false,
  })
  @MaxLength(2048)
  url: string;

  @ApiProperty({
    enum: SUBSCRIBABLE,
    isArray: true,
    description: 'Events to receive; `*` for all (including future ones)',
    example: ['payment.successful', 'payout.failed'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsIn(SUBSCRIBABLE, { each: true })
  eventTypes: string[];

  @ApiPropertyOptional({ example: 'Production order service', maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  description?: string;
}

export class UpdateWebhookEndpointRequestDto {
  @ApiPropertyOptional({ example: 'https://api.example.com/finstack/webhooks' })
  @IsOptional()
  @Transform(trim)
  @IsUrl({
    protocols: ['https', 'http'],
    require_protocol: true,
    require_tld: false,
  })
  @MaxLength(2048)
  url?: string;

  @ApiPropertyOptional({ enum: SUBSCRIBABLE, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsIn(SUBSCRIBABLE, { each: true })
  eventTypes?: string[];

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({
    description: 'Re-enabling also clears a disable caused by failures',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class RotateWebhookSecretRequestDto {
  @ApiPropertyOptional({
    description:
      'Hours the old secret keeps signing alongside the new one (0 = revoke it now)',
    minimum: 0,
    maximum: 168,
    default: 24,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(168)
  graceHours: number = 24;
}

export class ListWebhookDeliveriesQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ enum: WebhookDeliveryStatus })
  @IsOptional()
  @IsEnum(WebhookDeliveryStatus)
  status?: WebhookDeliveryStatus;

  @ApiPropertyOptional({ description: 'Opaque cursor from `nextCursor`' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

export class WebhookEndpointResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'https://api.example.com/finstack/webhooks' })
  url: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ type: [String], example: ['payment.successful'] })
  eventTypes: string[];

  @ApiProperty()
  enabled: boolean;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'Set when FinStack disabled it (e.g. repeated failures)',
  })
  disabledReason: string | null;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description:
      'Until when the previous secret still signs (after a rotation)',
  })
  previousSecretExpiresAt: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  static from(endpoint: WebhookEndpoint): WebhookEndpointResponseDto {
    return {
      id: endpoint.id,
      url: endpoint.url,
      description: endpoint.description,
      eventTypes: endpoint.eventTypes,
      enabled: endpoint.enabled,
      disabledReason: endpoint.disabledReason,
      previousSecretExpiresAt:
        endpoint.previousSecretExpiresAt &&
        endpoint.previousSecretExpiresAt.getTime() > Date.now()
          ? endpoint.previousSecretExpiresAt
          : null,
      createdAt: endpoint.createdAt,
    };
  }
}

export class WebhookEndpointWithSecretResponseDto extends WebhookEndpointResponseDto {
  @ApiProperty({
    description:
      'Signing secret. Shown only now: store it to verify FinStack-Signature.',
    example: 'whsec_3q2-7wS0...',
  })
  secret: string;
}

export class WebhookDeliveryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid', description: 'The event id (dedupe on it)' })
  eventId: string;

  @ApiProperty({ example: 'payment.successful' })
  eventType: string;

  @ApiProperty({ enum: WebhookDeliveryStatus })
  status: WebhookDeliveryStatus;

  @ApiProperty({ example: 1 })
  attempts: number;

  @ApiProperty({ nullable: true, example: 200 })
  lastResponseStatus: number | null;

  @ApiProperty({ nullable: true })
  lastError: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastAttemptAt: Date | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  deliveredAt: Date | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The exact request body',
  })
  payload: object;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  static from(delivery: WebhookDelivery): WebhookDeliveryResponseDto {
    return {
      id: delivery.id,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      status: delivery.status,
      attempts: delivery.attempts,
      lastResponseStatus: delivery.lastResponseStatus,
      lastError: delivery.lastError,
      lastAttemptAt: delivery.lastAttemptAt,
      deliveredAt: delivery.deliveredAt,
      payload: delivery.payload,
      createdAt: delivery.createdAt,
    };
  }
}

export class WebhookDeliveriesPageDto {
  @ApiProperty({ type: [WebhookDeliveryResponseDto] })
  data: WebhookDeliveryResponseDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}
