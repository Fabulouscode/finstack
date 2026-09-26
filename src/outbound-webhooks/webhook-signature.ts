import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'FinStack-Signature';

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/**
 * `t=<unix seconds>,v1=<hex>[,v1=<hex>]`: HMAC-SHA256 of `<t>.<body>` with
 * each active secret (two during a rotation). Receivers accept the request
 * if any v1 matches theirs and `t` is recent, which also stops replays.
 */
export function signatureHeader(
  secrets: string[],
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const signatures = secrets.map(
    (secret) => `v1=${sign(secret, timestamp, body)}`,
  );
  return [`t=${timestamp}`, ...signatures].join(',');
}

/**
 * Receiver-side verification, as integrators should implement it (also
 * used by FinStack's own tests).
 */
export function verifySignatureHeader(
  header: string,
  secret: string,
  body: string,
  toleranceSeconds = 300,
  now = Date.now(),
): boolean {
  const parts = header.split(',').map((part) => part.split('=', 2));
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  if (
    !Number.isInteger(timestamp) ||
    Math.abs(now / 1000 - timestamp) > toleranceSeconds
  ) {
    return false;
  }
  const expected = Buffer.from(sign(secret, timestamp, body), 'hex');
  return parts
    .filter(
      ([key, value]) => key === 'v1' && /^[0-9a-f]{64}$/.test(value ?? ''),
    )
    .some(([, value]) =>
      timingSafeEqual(Buffer.from(value ?? '', 'hex'), expected),
    );
}

function sign(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}
