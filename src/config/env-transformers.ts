/**
 * class-transformer helper for boolean env vars. Only the exact strings
 * "true" and "false" are converted; anything else is passed through so
 * `@IsBoolean()` rejects it instead of silently coercing "yes" or "1".
 */
export const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};
