import { User, UserRole, UserStatus } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import {
  AccountSuspendedException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
} from './auth.errors';
import { AuthService } from './auth.service';
import { AccessTokenService } from './tokens/access-token.service';
import { RefreshTokenService } from './tokens/refresh-token.service';

function buildUser(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: 'user-1',
    email: 'ada@example.com',
    passwordHash: '$argon2id$stored',
    firstName: 'Ada',
    lastName: 'Lovelace',
    role: UserRole.User,
    status: UserStatus.Active,
    createdAt: new Date('2026-09-24T10:00:00Z'),
    updatedAt: new Date('2026-09-24T10:00:00Z'),
    ...overrides,
  });
}

describe('AuthService', () => {
  const users = {
    create: jest.fn(),
    findById: jest.fn(),
    findByEmailWithPasswordHash: jest.fn(),
  };
  const passwords = {
    hash: jest.fn(),
    verify: jest.fn(),
    verifyAgainstDummy: jest.fn(),
  };
  const accessTokens = { sign: jest.fn(), ttlSeconds: 900 };
  const refreshTokens = {
    issue: jest.fn(),
    rotate: jest.fn(),
    revoke: jest.fn(),
    revokeFamily: jest.fn(),
    revokeAllForUser: jest.fn(),
  };
  const refreshExpiry = new Date('2026-10-24T10:00:00Z');

  const service = new AuthService(
    users as unknown as UsersService,
    passwords,
    accessTokens as unknown as AccessTokenService,
    refreshTokens as unknown as RefreshTokenService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    accessTokens.sign.mockResolvedValue('access-token');
    refreshTokens.issue.mockResolvedValue({
      token: 'refresh-token',
      expiresAt: refreshExpiry,
    });
  });

  describe('register', () => {
    it('stores a hash (never the password) and starts a session', async () => {
      passwords.hash.mockResolvedValue('$argon2id$new');
      users.create.mockResolvedValue(buildUser());

      const result = await service.register({
        email: 'ada@example.com',
        password: 'correct-horse-battery-staple',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });

      expect(users.create).toHaveBeenCalledWith({
        email: 'ada@example.com',
        passwordHash: '$argon2id$new',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      expect(result.tokens).toEqual({
        tokenType: 'Bearer',
        accessToken: 'access-token',
        accessTokenExpiresIn: 900,
        refreshToken: 'refresh-token',
        refreshTokenExpiresAt: refreshExpiry,
      });
      expect(Object.keys(result.user)).not.toContain('passwordHash');
    });
  });

  describe('login', () => {
    const credentials = {
      email: 'ada@example.com',
      password: 'correct-horse-battery-staple',
    };

    it('returns a session for valid credentials', async () => {
      users.findByEmailWithPasswordHash.mockResolvedValue(buildUser());
      passwords.verify.mockResolvedValue(true);

      await expect(service.login(credentials)).resolves.toMatchObject({
        user: { id: 'user-1' },
        tokens: { accessToken: 'access-token' },
      });
      expect(refreshTokens.issue).toHaveBeenCalledWith('user-1');
    });

    it('rejects a wrong password', async () => {
      users.findByEmailWithPasswordHash.mockResolvedValue(buildUser());
      passwords.verify.mockResolvedValue(false);

      await expect(service.login(credentials)).rejects.toThrow(
        InvalidCredentialsException,
      );
      expect(refreshTokens.issue).not.toHaveBeenCalled();
    });

    it('rejects an unknown email with the same error, after a dummy hash check', async () => {
      users.findByEmailWithPasswordHash.mockResolvedValue(null);
      passwords.verifyAgainstDummy.mockResolvedValue(false);

      await expect(service.login(credentials)).rejects.toThrow(
        InvalidCredentialsException,
      );
      expect(passwords.verifyAgainstDummy).toHaveBeenCalledWith(
        credentials.password,
      );
    });

    it('rejects a suspended account only after the password is verified', async () => {
      users.findByEmailWithPasswordHash.mockResolvedValue(
        buildUser({ status: UserStatus.Suspended }),
      );
      passwords.verify.mockResolvedValue(true);

      await expect(service.login(credentials)).rejects.toThrow(
        AccountSuspendedException,
      );
    });

    it('does not reveal suspension to someone with the wrong password', async () => {
      users.findByEmailWithPasswordHash.mockResolvedValue(
        buildUser({ status: UserStatus.Suspended }),
      );
      passwords.verify.mockResolvedValue(false);

      await expect(service.login(credentials)).rejects.toThrow(
        InvalidCredentialsException,
      );
    });
  });

  describe('refresh', () => {
    const rotated = {
      token: 'next-refresh-token',
      expiresAt: refreshExpiry,
      userId: 'user-1',
      familyId: 'family-1',
    };

    it('returns a new token pair', async () => {
      refreshTokens.rotate.mockResolvedValue(rotated);
      users.findById.mockResolvedValue(buildUser());

      await expect(service.refresh('old')).resolves.toMatchObject({
        accessToken: 'access-token',
        refreshToken: 'next-refresh-token',
      });
    });

    it('revokes the session when the user has since been suspended', async () => {
      refreshTokens.rotate.mockResolvedValue(rotated);
      users.findById.mockResolvedValue(
        buildUser({ status: UserStatus.Suspended }),
      );

      await expect(service.refresh('old')).rejects.toThrow(
        InvalidRefreshTokenException,
      );
      expect(refreshTokens.revokeFamily).toHaveBeenCalledWith('family-1');
    });

    it('revokes the session when the user no longer exists', async () => {
      refreshTokens.rotate.mockResolvedValue(rotated);
      users.findById.mockResolvedValue(null);

      await expect(service.refresh('old')).rejects.toThrow(
        InvalidRefreshTokenException,
      );
      expect(refreshTokens.revokeFamily).toHaveBeenCalledWith('family-1');
    });
  });
});
