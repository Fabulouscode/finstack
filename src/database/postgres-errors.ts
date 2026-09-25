import { QueryFailedError } from 'typeorm';

/** PostgreSQL SQLSTATE codes we react to. */
export const PostgresErrorCode = {
  UniqueViolation: '23505',
  ForeignKeyViolation: '23503',
  CheckViolation: '23514',
} as const;

interface PostgresDriverError {
  code?: string;
  constraint?: string;
}

/**
 * True when `error` is a unique-constraint violation, optionally on a
 * specific constraint. Lets services turn races that the database resolved
 * (e.g. two concurrent sign-ups with one email) into domain errors.
 */
export function isUniqueViolation(
  error: unknown,
  constraint?: string | readonly string[],
): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as PostgresDriverError;

  return (
    driverError.code === PostgresErrorCode.UniqueViolation &&
    (constraint === undefined ||
      (typeof constraint === 'string'
        ? driverError.constraint === constraint
        : constraint.includes(driverError.constraint ?? '')))
  );
}
