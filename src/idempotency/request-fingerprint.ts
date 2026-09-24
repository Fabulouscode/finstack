import { createHash } from 'node:crypto';

/** JSON with object keys sorted recursively, so key order never matters. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function requestHash(
  method: string,
  path: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${canonicalJson(body ?? null)}`)
    .digest('hex');
}

const VALID_KEY = /^[A-Za-z0-9_\-:.]{1,255}$/;

export function isValidIdempotencyKey(key: string | undefined): key is string {
  return key !== undefined && VALID_KEY.test(key);
}
