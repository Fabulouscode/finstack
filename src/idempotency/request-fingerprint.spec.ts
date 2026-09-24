import {
  canonicalJson,
  isValidIdempotencyKey,
  requestHash,
} from './request-fingerprint';

describe('canonicalJson', () => {
  it('is independent of object key order, at any depth', () => {
    expect(
      canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }),
    ).toBe(canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  });

  it('keeps array order significant and drops undefined properties', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe('requestHash', () => {
  const body = { recipientEmail: 'bob@example.com', amount: 2500 };

  it('matches for the same request regardless of key order', () => {
    expect(requestHash('POST', '/v1/transfers', body)).toBe(
      requestHash('post', '/v1/transfers', {
        amount: 2500,
        recipientEmail: 'bob@example.com',
      }),
    );
  });

  it('differs when the method, path or body differ', () => {
    const base = requestHash('POST', '/v1/transfers', body);

    expect(requestHash('PUT', '/v1/transfers', body)).not.toBe(base);
    expect(requestHash('POST', '/v1/other', body)).not.toBe(base);
    expect(
      requestHash('POST', '/v1/transfers', { ...body, amount: 2501 }),
    ).not.toBe(base);
  });
});

describe('isValidIdempotencyKey', () => {
  it.each([
    '5f1d7e0c-8a3b-4c2d-9e6f-1a2b3c4d5e6f',
    'order:123.retry_1',
    'k'.repeat(255),
  ])('accepts %p', (key) => {
    expect(isValidIdempotencyKey(key)).toBe(true);
  });

  it.each([undefined, '', 'has space', 'k'.repeat(256), 'emoji-💸', 'a\r\nb'])(
    'rejects %p',
    (key) => {
      expect(isValidIdempotencyKey(key)).toBe(false);
    },
  );
});
