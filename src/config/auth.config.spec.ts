import { authConfig } from './auth.config';
import { ConfigValidationError } from './validate-config';

describe('authConfig', () => {
  const originalEnv = process.env;
  const strongSecret = 'k3Jx9vQ2mR8tW5yZ1aB4cD7eF0gH3iJ6kL9mN2oP5qR8';

  beforeEach(() => {
    process.env = { JWT_ACCESS_SECRET: strongSecret };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('applies secure defaults', () => {
    expect(authConfig()).toEqual({
      accessToken: {
        secret: strongSecret,
        ttlSeconds: 900,
        issuer: 'finstack',
        audience: 'finstack-api',
      },
      refreshToken: { ttlMs: 30 * 24 * 60 * 60 * 1000 },
    });
  });

  it('requires a secret of at least 32 characters', () => {
    process.env.JWT_ACCESS_SECRET = 'too-short';
    expect(() => authConfig()).toThrow(ConfigValidationError);

    delete process.env.JWT_ACCESS_SECRET;
    expect(() => authConfig()).toThrow(ConfigValidationError);
  });

  it('refuses the .env.example placeholder in production', () => {
    process.env = {
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET:
        'change-me-to-a-long-random-secret-of-at-least-32-chars',
    };

    expect(() => authConfig()).toThrow(
      /placeholder must not be used in production/,
    );
  });

  it('allows the placeholder outside production', () => {
    process.env.JWT_ACCESS_SECRET =
      'change-me-to-a-long-random-secret-of-at-least-32-chars';

    expect(() => authConfig()).not.toThrow();
  });

  it.each([
    ['JWT_ACCESS_TTL_SECONDS', '30'],
    ['JWT_ACCESS_TTL_SECONDS', '100000'],
    ['REFRESH_TOKEN_TTL_DAYS', '0'],
  ])('rejects %s=%s', (name, value) => {
    process.env[name] = value;

    expect(() => authConfig()).toThrow(ConfigValidationError);
  });
});
