import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserResponseDto } from '../../users/dto/user-response.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

// ---- Requests -----------------------------------------------------------------

export class RegisterRequestDto {
  @ApiProperty({ example: 'ada@example.com', maxLength: 320 })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(320)
  email: string;

  @ApiProperty({
    description:
      '12–128 characters. Long passphrases are encouraged; there are no composition rules (NIST SP 800-63B).',
    example: 'correct-horse-battery-staple',
    minLength: 12,
    maxLength: 128,
  })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password: string;

  @ApiProperty({ example: 'Ada', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ example: 'Lovelace', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;
}

export class LoginRequestDto {
  @ApiProperty({ example: 'ada@example.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(320)
  email: string;

  @ApiProperty({ example: 'correct-horse-battery-staple' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;
}

export class RefreshTokenRequestDto {
  @ApiProperty({
    description: 'Refresh token from a previous login or refresh',
    example: 'q0v5tX1n9eE3p8m2Yf7kR4wL6sJ0aB1cD2eF3gH4iJ5',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  refreshToken: string;
}

// ---- Responses ----------------------------------------------------------------

export class TokenPairDto {
  @ApiProperty({ example: 'Bearer' })
  tokenType: 'Bearer';

  @ApiProperty({
    description: 'JWT to send as `Authorization: Bearer <token>`',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoidXNlciJ9.sig',
  })
  accessToken: string;

  @ApiProperty({
    description: 'Access token lifetime in seconds',
    example: 900,
  })
  accessTokenExpiresIn: number;

  @ApiProperty({
    description:
      'Single-use token for POST /v1/auth/refresh. Store it securely; every refresh returns a new one.',
    example: 'q0v5tX1n9eE3p8m2Yf7kR4wL6sJ0aB1cD2eF3gH4iJ5',
  })
  refreshToken: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-24T10:00:00.000Z' })
  refreshTokenExpiresAt: Date;
}

export class AuthResponseDto {
  @ApiProperty({ type: UserResponseDto })
  user: UserResponseDto;

  @ApiProperty({ type: TokenPairDto })
  tokens: TokenPairDto;
}
