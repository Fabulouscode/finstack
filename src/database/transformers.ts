import { ValueTransformer } from 'typeorm';

/**
 * Maps PostgreSQL `bigint` (returned by `pg` as a string to avoid precision
 * loss) to a JavaScript `bigint`. Money never passes through `number` here.
 */
export const bigintTransformer: ValueTransformer = {
  to: (value: bigint | null | undefined): string | null | undefined =>
    value === null || value === undefined ? value : value.toString(),
  from: (value: string | null): bigint | null =>
    value === null ? null : BigInt(value),
};
