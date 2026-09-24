import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AuthResponseDto, TokenPairDto } from '../src/auth/dto/auth.dto';
import { ProblemDetails } from '../src/common/http/problem-details';
import { UserResponseDto } from '../src/users/dto/user-response.dto';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';

const registration = {
  email: 'Ada@Example.com',
  password: 'correct-horse-battery-staple',
  firstName: 'Ada',
  lastName: 'Lovelace',
};

describe('Auth (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;

  const api = (): ReturnType<typeof request> => request(app.getHttpServer());

  async function register(body = registration): Promise<AuthResponseDto> {
    const response = await api()
      .post('/v1/auth/register')
      .send(body)
      .expect(201);
    return response.body as AuthResponseDto;
  }

  async function refresh(
    refreshToken: string,
    status: number,
  ): Promise<request.Response> {
    return api().post('/v1/auth/refresh').send({ refreshToken }).expect(status);
  }

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    await resetDatabase(app.get(DataSource));
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  describe('POST /v1/auth/register', () => {
    it('creates the account and returns a session', async () => {
      const { user, tokens } = await register();

      expect(user).toMatchObject({
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        role: 'user',
        status: 'active',
      });
      expect(user).not.toHaveProperty('passwordHash');
      expect(tokens).toMatchObject({
        tokenType: 'Bearer',
        accessTokenExpiresIn: 900,
      });
      expect(tokens.accessToken.split('.')).toHaveLength(3);
    });

    it('rejects a duplicate email with 409 EMAIL_ALREADY_REGISTERED', async () => {
      await register();

      const response = await api()
        .post('/v1/auth/register')
        .send({ ...registration, email: 'ADA@example.com' })
        .expect(409);

      expect(response.body).toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED' });
    });

    it('validates the payload', async () => {
      const response = await api()
        .post('/v1/auth/register')
        .send({
          email: 'not-an-email',
          password: 'short',
          firstName: '  ',
          lastName: 'L',
        })
        .expect(400);

      const fields = (response.body as ProblemDetails).errors?.map(
        (e) => e.field,
      );
      expect(fields).toEqual(['email', 'password', 'firstName']);
    });

    it('rejects passwords longer than 128 characters', async () => {
      await api()
        .post('/v1/auth/register')
        .send({ ...registration, password: 'x'.repeat(129) })
        .expect(400);
    });
  });

  describe('POST /v1/auth/login', () => {
    beforeEach(() => register());

    it('signs in with the right credentials, case-insensitively on email', async () => {
      const response = await api()
        .post('/v1/auth/login')
        .send({ email: 'ADA@example.COM', password: registration.password })
        .expect(200);

      expect((response.body as AuthResponseDto).user.email).toBe(
        'ada@example.com',
      );
    });

    it.each([
      [
        'a wrong password',
        { email: registration.email, password: 'wrong-password-123' },
      ],
      [
        'an unknown email',
        { email: 'nobody@example.com', password: registration.password },
      ],
    ])(
      'returns the same 401 INVALID_CREDENTIALS for %s',
      async (_label, body) => {
        const response = await api()
          .post('/v1/auth/login')
          .send(body)
          .expect(401);

        expect(response.body).toMatchObject({
          code: 'INVALID_CREDENTIALS',
          detail: 'Email or password is incorrect',
        });
      },
    );

    it('returns 403 ACCOUNT_SUSPENDED for a suspended account', async () => {
      await app
        .get(DataSource)
        .query(
          `UPDATE users SET status = 'suspended' WHERE email = 'ada@example.com'`,
        );

      const response = await api()
        .post('/v1/auth/login')
        .send({ email: registration.email, password: registration.password })
        .expect(403);

      expect(response.body).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    });
  });

  describe('GET /v1/users/me', () => {
    it('returns the current user for a valid access token', async () => {
      const { user, tokens } = await register();

      const response = await api()
        .get('/v1/users/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      expect(response.body as UserResponseDto).toEqual(
        expect.objectContaining({ id: user.id, email: 'ada@example.com' }),
      );
    });

    it.each([
      ['no token', undefined],
      ['a malformed header', 'Token abc'],
      ['a forged token', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged'],
    ])('returns 401 UNAUTHENTICATED with %s', async (_label, header) => {
      const call = api().get('/v1/users/me');
      if (header) call.set('Authorization', header);

      const response = await call.expect(401);
      expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('does not accept a refresh token as an access token', async () => {
      const { tokens } = await register();

      await api()
        .get('/v1/users/me')
        .set('Authorization', `Bearer ${tokens.refreshToken}`)
        .expect(401);
    });
  });

  describe('POST /v1/auth/refresh', () => {
    it('rotates tokens; the new access token works', async () => {
      const { tokens } = await register();

      const rotated = (await refresh(tokens.refreshToken, 200))
        .body as TokenPairDto;

      expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
      await api()
        .get('/v1/users/me')
        .set('Authorization', `Bearer ${rotated.accessToken}`)
        .expect(200);
    });

    it('detects reuse of a rotated token and ends the session', async () => {
      const { tokens } = await register();
      const rotated = (await refresh(tokens.refreshToken, 200))
        .body as TokenPairDto;

      const reuse = await refresh(tokens.refreshToken, 401);
      expect(reuse.body).toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });

      // Whoever holds the latest token is signed out too.
      await refresh(rotated.refreshToken, 401);
    });

    it('rejects a refresh token of a user suspended since sign-in', async () => {
      const { tokens } = await register();
      await app.get(DataSource).query(`UPDATE users SET status = 'suspended'`);

      await refresh(tokens.refreshToken, 401);
    });
  });

  describe('POST /v1/auth/logout and /logout-all', () => {
    it('logout ends only that session and is idempotent', async () => {
      const first = await register();
      const second = (
        await api()
          .post('/v1/auth/login')
          .send({ email: registration.email, password: registration.password })
          .expect(200)
      ).body as AuthResponseDto;

      await api()
        .post('/v1/auth/logout')
        .send({ refreshToken: first.tokens.refreshToken })
        .expect(204);
      await api()
        .post('/v1/auth/logout')
        .send({ refreshToken: first.tokens.refreshToken })
        .expect(204);

      await refresh(first.tokens.refreshToken, 401);
      await refresh(second.tokens.refreshToken, 200);
    });

    it('logout-all requires authentication and ends every session', async () => {
      const first = await register();
      const second = (
        await api()
          .post('/v1/auth/login')
          .send({ email: registration.email, password: registration.password })
          .expect(200)
      ).body as AuthResponseDto;

      await api().post('/v1/auth/logout-all').expect(401);
      await api()
        .post('/v1/auth/logout-all')
        .set('Authorization', `Bearer ${first.tokens.accessToken}`)
        .expect(204);

      await refresh(first.tokens.refreshToken, 401);
      await refresh(second.tokens.refreshToken, 401);
    });
  });
});

describe('Auth rate limiting (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '3' };
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  it('throttles credential endpoints more strictly than the rest of the API', async () => {
    const attempt = (): request.Test =>
      request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: 'x@example.com', password: 'wrong-password-123' });

    for (let i = 0; i < 3; i++) {
      await attempt().expect(401);
    }
    const response = await attempt().expect(429);
    expect(response.body).toMatchObject({ code: 'RATE_LIMITED' });

    // Other endpoints still work: the auth limit is per endpoint, not global.
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/v1/users/me').expect(401);
  });
});
