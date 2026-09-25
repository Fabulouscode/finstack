import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDate,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinDate,
  ValidateIf,
} from 'class-validator';
import { OrgPermission } from '../../organizations/organization-permissions';
import { API_KEY_SCOPES } from '../api-key-principal';
import { ApiKey } from '../api-key.entity';

export class CreateApiKeyRequestDto {
  @ApiProperty({ example: 'Checkout server', maxLength: 100 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    enum: API_KEY_SCOPES,
    isArray: true,
    example: [OrgPermission.CreatePayments, OrgPermission.ReadTransactions],
    description:
      'What the key may do; keys cannot manage members, keys or the organization',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(API_KEY_SCOPES, { each: true })
  scopes: OrgPermission[];

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Optional expiry (must be in the future)',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @Type(() => Date)
  @IsDate()
  @MinDate(() => new Date())
  expiresAt?: Date;
}

export class ApiKeyResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Checkout server' })
  name: string;

  @ApiProperty({
    description: 'Non-secret identifier',
    example: 'fsk_test_1a2b3c4d',
  })
  prefix: string;

  @ApiProperty({ type: [String], example: ['payments:create'] })
  scopes: string[];

  @ApiProperty({ format: 'date-time', nullable: true })
  lastUsedAt: Date | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  expiresAt: Date | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  revokedAt: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  static from(apiKey: ApiKey): ApiKeyResponseDto {
    return {
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      scopes: apiKey.scopes,
      lastUsedAt: apiKey.lastUsedAt,
      expiresAt: apiKey.expiresAt,
      revokedAt: apiKey.revokedAt,
      createdAt: apiKey.createdAt,
    };
  }
}

export class CreatedApiKeyResponseDto extends ApiKeyResponseDto {
  @ApiProperty({
    description:
      'The secret key. Shown ONCE; store it securely. Send it as the X-API-Key header.',
    example: 'fsk_test_1a2b3c4d_q0v5tX1n9eE3p8m2Yf7kR4wL6sJ0aB1cD2eF3gH4iJ5',
  })
  key: string;
}
