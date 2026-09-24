import { EntryCursor } from '../ledger/ledger.service';
import { InvalidCursorException } from './wallets.errors';

/** Opaque, URL-safe cursor: base64url("<ISO timestamp>|<entry id>"). */
export function encodeCursor(cursor: EntryCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`).toString(
    'base64url',
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(value: string): EntryCursor {
  const [timestamp, id, ...rest] = Buffer.from(value, 'base64url')
    .toString('utf8')
    .split('|');
  const createdAt = new Date(timestamp ?? '');

  if (
    rest.length > 0 ||
    !id ||
    !UUID.test(id) ||
    Number.isNaN(createdAt.getTime())
  ) {
    throw new InvalidCursorException();
  }
  return { createdAt, id };
}
