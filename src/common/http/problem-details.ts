import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json';

export interface FieldError {
  /** Dot-separated path to the invalid field, e.g. `destination.accountId`. */
  field: string;
  messages: string[];
}

/** Error body following RFC 9457 (Problem Details for HTTP APIs). */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId?: string;
  errors?: FieldError[];
}

// ---- Swagger schemas --------------------------------------------------------

export class FieldErrorDto implements FieldError {
  @ApiProperty({ example: 'amount' })
  field: string;

  @ApiProperty({ example: ['amount must be a positive integer'] })
  messages: string[];
}

export class ProblemDetailsDto implements ProblemDetails {
  @ApiProperty({
    description:
      'Problem type URI. `about:blank` when the HTTP status says it all.',
    example: 'about:blank',
  })
  type: string;

  @ApiProperty({ description: 'HTTP status phrase', example: 'Not Found' })
  title: string;

  @ApiProperty({ example: 404 })
  status: number;

  @ApiProperty({
    description: 'Human-readable explanation of this occurrence',
    example: 'Wallet not found',
  })
  detail: string;

  @ApiProperty({ description: 'Request path', example: '/v1/wallets/123' })
  instance: string;

  @ApiProperty({
    description: 'Stable, machine-readable error code for client logic',
    example: 'NOT_FOUND',
  })
  code: string;

  @ApiPropertyOptional({
    description: 'Correlates the error with server logs (`X-Request-Id`)',
    example: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  })
  requestId?: string;
}

export class ValidationProblemDetailsDto extends ProblemDetailsDto {
  @ApiProperty({ example: 'Bad Request' })
  declare title: string;

  @ApiProperty({ example: 400 })
  declare status: number;

  @ApiProperty({ example: 'Request validation failed' })
  declare detail: string;

  @ApiProperty({ example: 'VALIDATION_ERROR' })
  declare code: string;

  @ApiProperty({ type: [FieldErrorDto] })
  errors: FieldErrorDto[];
}
