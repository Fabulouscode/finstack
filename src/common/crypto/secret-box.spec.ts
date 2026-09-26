import { randomBytes } from 'node:crypto';
import { SecretBox } from './secret-box';

describe('SecretBox', () => {
  const box = new SecretBox({ dataEncryptionKey: randomBytes(32) });

  it('round-trips and never repeats a ciphertext', () => {
    const a = box.seal('whsec_abc');
    const b = box.seal('whsec_abc');
    expect(a).not.toBe(b);
    expect(a).not.toContain('whsec_abc');
    expect(box.open(a)).toBe('whsec_abc');
    expect(box.open(b)).toBe('whsec_abc');
  });

  it('detects tampering', () => {
    const [version, iv, ciphertext, tag] = box.seal('secret').split('.');
    const flipped = Buffer.from(ciphertext ?? '', 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() =>
      box.open([version, iv, flipped.toString('base64url'), tag].join('.')),
    ).toThrow();
  });

  it('cannot be opened with another key', () => {
    const other = new SecretBox({ dataEncryptionKey: randomBytes(32) });
    expect(() => other.open(box.seal('secret'))).toThrow();
  });
});
