import { JwtService } from '@nestjs/jwt';
import { AuthConfig } from '../../config/auth.config';
import { UserRole } from '../../users/user.entity';
import { AccessTokenService } from './access-token.service';

const config: AuthConfig = {
  accessToken: {
    secret: 'test-secret-that-is-at-least-32-characters',
    ttlSeconds: 900,
    issuer: 'finstack',
    audience: 'finstack-api',
  },
  refreshToken: { ttlMs: 1000 },
};

function jwtFor(
  overrides: Partial<AuthConfig['accessToken']> = {},
): JwtService {
  const options = { ...config.accessToken, ...overrides };
  return new JwtService({
    secret: options.secret,
    signOptions: {
      algorithm: 'HS256',
      expiresIn: options.ttlSeconds,
      issuer: options.issuer,
      audience: options.audience,
    },
    verifyOptions: {
      algorithms: ['HS256'],
      issuer: config.accessToken.issuer,
      audience: config.accessToken.audience,
    },
  });
}

const encode = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('AccessTokenService', () => {
  const service = new AccessTokenService(jwtFor(), config);
  const user = {
    id: '3f0e8d5a-8b5c-4c1e-9f3a-2d7b6c5e4a1b',
    role: UserRole.User,
  };

  it('round-trips the identity', async () => {
    const token = await service.sign(user);

    await expect(service.verify(token)).resolves.toEqual(user);
  });

  it('keeps personal data out of the token', async () => {
    const token = await service.sign(user);
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString(),
    ) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(
      ['aud', 'exp', 'iat', 'iss', 'role', 'sub'].sort(),
    );
  });

  it('rejects a token signed with another secret', async () => {
    const forged = await new AccessTokenService(
      jwtFor({ secret: 'another-secret-that-is-at-least-32-chars' }),
      config,
    ).sign(user);

    await expect(service.verify(forged)).resolves.toBeNull();
  });

  it('rejects a token for another audience or issuer', async () => {
    const otherAudience = await new AccessTokenService(
      jwtFor({ audience: 'another-api' }),
      config,
    ).sign(user);
    const otherIssuer = await new AccessTokenService(
      jwtFor({ issuer: 'someone-else' }),
      config,
    ).sign(user);

    await expect(service.verify(otherAudience)).resolves.toBeNull();
    await expect(service.verify(otherIssuer)).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await service.sign(user);

    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      jest.setSystemTime(
        Date.now() + (config.accessToken.ttlSeconds + 1) * 1000,
      );
      await expect(service.verify(token)).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects an unsigned token (alg "none")', async () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: user.id,
      role: 'admin',
      iss: 'finstack',
      aud: 'finstack-api',
      iat: now,
      exp: now + 900,
    })}.`;

    await expect(service.verify(unsigned)).resolves.toBeNull();
  });

  it('rejects a validly signed token with an unknown role', async () => {
    const token = await jwtFor().signAsync(
      { role: 'superuser' },
      { subject: user.id },
    );

    await expect(service.verify(token)).resolves.toBeNull();
  });

  it('rejects garbage', async () => {
    await expect(service.verify('not.a.jwt')).resolves.toBeNull();
  });
});
