import { HttpStatus } from '@nestjs/common';
import { AppException } from '../http/app.exception';

/** Position in a list ordered by (created_at DESC, id DESC). */
export interface Cursor {
  createdAt: Date;
  id: string;
}

export class InvalidCursorException extends AppException {
  constructor() {
    super(
      'INVALID_CURSOR',
      'The pagination cursor is invalid',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/** Opaque, URL-safe cursor: base64url("<ISO timestamp>|<entry id>"). */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`).toString(
    'base64url',
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(value: string): Cursor {
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
