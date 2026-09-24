import { PasswordHasher } from './password-hasher';

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('hashes with argon2id and a random salt', async () => {
    const first = await hasher.hash('correct-horse-battery-staple');
    const second = await hasher.hash('correct-horse-battery-staple');

    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(first).not.toBe(second);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hasher.hash('correct-horse-battery-staple');

    await expect(
      hasher.verify(hash, 'correct-horse-battery-staple'),
    ).resolves.toBe(true);
    await expect(
      hasher.verify(hash, 'Correct-horse-battery-staple'),
    ).resolves.toBe(false);
  });

  it('treats a malformed hash as a failed match instead of throwing', async () => {
    await expect(hasher.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('always fails the dummy verification', async () => {
    await expect(
      hasher.verifyAgainstDummy('finstack-dummy-password-for-timing'),
    ).resolves.toBe(false);
  });
});
