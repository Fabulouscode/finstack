import { ClassConstructor, plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';

export class ConfigValidationError extends Error {
  constructor(
    readonly namespace: string,
    readonly violations: string[],
  ) {
    super(
      `Invalid "${namespace}" configuration:\n${violations
        .map((violation) => `  - ${violation}`)
        .join('\n')}`,
    );
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validates raw environment variables against a class-validator schema.
 *
 * Collects every violation before throwing so a misconfigured deployment
 * surfaces all problems at once instead of one per restart.
 */
export function validateConfig<T extends object>(
  namespace: string,
  schema: ClassConstructor<T>,
  env: Record<string, string | undefined>,
): T {
  const config = plainToInstance(schema, env, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(config, {
    skipMissingProperties: false,
    whitelist: true,
  });

  if (errors.length > 0) {
    throw new ConfigValidationError(namespace, errors.map(formatError));
  }

  return config;
}

function formatError(error: ValidationError): string {
  const reasons = Object.values(error.constraints ?? {}).join(', ');
  return `${error.property}: ${reasons}`;
}
