import { ValidationError, ValidationPipe } from '@nestjs/common';
import { RequestValidationException } from './app.exception';
import { FieldError } from './problem-details';

/** Flattens nested class-validator errors into `field.path: messages[]`. */
export function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): FieldError[] {
  return errors.flatMap((error) => {
    const field = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;
    const own: FieldError[] = error.constraints
      ? [{ field, messages: Object.values(error.constraints) }]
      : [];

    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    // Strip unknown properties and reject requests that send them.
    whitelist: true,
    forbidNonWhitelisted: true,
    // Produce DTO class instances, but never guess types: "100" must not
    // silently become 100 for a money field. Use explicit @Type() instead.
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    // Keep submitted values out of error payloads (they may be sensitive).
    validationError: { target: false, value: false },
    exceptionFactory: (errors) =>
      new RequestValidationException(flattenValidationErrors(errors)),
  });
}
