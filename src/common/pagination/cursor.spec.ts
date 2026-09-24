import { decodeCursor, encodeCursor, InvalidCursorException } from './cursor';

describe('pagination cursor', () => {
  const cursor = {
    createdAt: new Date('2026-09-24T10:00:00.123Z'),
    id: '6a1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  };

  it('round-trips with millisecond precision', () => {
    const encoded = encodeCursor(cursor);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    [
      'a bad date',
      Buffer.from('yesterday|6a1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d').toString(
        'base64url',
      ),
    ],
    [
      'a bad id',
      Buffer.from('2026-09-24T10:00:00.000Z|1 OR 1=1').toString('base64url'),
    ],
    [
      'extra parts',
      Buffer.from(`2026-09-24T10:00:00.000Z|${cursor.id}|x`).toString(
        'base64url',
      ),
    ],
  ])('rejects %s', (_label, value) => {
    expect(() => decodeCursor(value)).toThrow(InvalidCursorException);
  });
});
