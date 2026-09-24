import { applyDecorators } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiResponse,
  ApiResponseOptions,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  PROBLEM_JSON_CONTENT_TYPE,
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../common/http/problem-details';

/** OpenAPI response object for a problem+json error. */
export function problemResponse(
  status: number,
  description: string,
  schema: typeof ProblemDetailsDto = ProblemDetailsDto,
): ApiResponseOptions {
  return {
    status,
    description,
    content: {
      [PROBLEM_JSON_CONTENT_TYPE]: {
        schema: { $ref: getSchemaPath(schema) },
      },
    },
  };
}

/**
 * Documents an error response, e.g.
 * `@ApiProblemResponse(409, 'EMAIL_ALREADY_REGISTERED: email is taken')`.
 */
export function ApiProblemResponse(
  status: number,
  description: string,
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiExtraModels(ProblemDetailsDto),
    ApiResponse(problemResponse(status, description)),
  );
}

/** Documents the 400 VALIDATION_ERROR response of an endpoint with a body. */
export function ApiValidationProblemResponse(): MethodDecorator &
  ClassDecorator {
  return applyDecorators(
    ApiExtraModels(ValidationProblemDetailsDto),
    ApiResponse(
      problemResponse(
        400,
        'VALIDATION_ERROR: the request body is invalid. See `errors`.',
        ValidationProblemDetailsDto,
      ),
    ),
  );
}
