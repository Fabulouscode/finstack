import {
  Body,
  Controller,
  Get,
  HttpStatus,
  INestApplication,
  Post,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsPositive, Matches, ValidateNested } from 'class-validator';
import request from 'supertest';
import { App } from 'supertest/types';
import { Public } from '../src/auth/decorators/public.decorator';
import { AppException } from '../src/common/http/app.exception';
import { ProblemDetails } from '../src/common/http/problem-details';
import { createTestApp } from './utils/create-test-app';

class DestinationDto {
  @IsInt()
  @IsPositive()
  accountId: number;
}

class TransferDto {
  @IsInt()
  @IsPositive()
  amount: number;

  @Matches(/^[A-Z]{3}$/)
  currency: string;

  @ValidateNested()
  @Type(() => DestinationDto)
  destination: DestinationDto;
}

/** Test-only controller exercising the global HTTP pipeline. */
@Public()
@Controller('probe')
class ProbeController {
  @Post('transfers')
  transfer(@Body() body: TransferDto): TransferDto {
    return body;
  }

  @Get('insufficient-funds')
  insufficientFunds(): never {
    throw new AppException(
      'INSUFFICIENT_FUNDS',
      'Available balance is too low',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  @Get('crash')
  crash(): never {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
  }

  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }
}

const UUID = /^[0-9a-f-]{36}$/;
const validTransfer = {
  amount: 150000,
  currency: 'NGN',
  destination: { accountId: 7 },
};

describe('HTTP foundation (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;

  async function boot(env: Record<string, string> = {}): Promise<void> {
    process.env = { ...originalEnv, ...env };
    app = await createTestApp({ controllers: [ProbeController] });
  }

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  describe('validation and errors', () => {
    beforeEach(() => boot());

    it('accepts a valid body', async () => {
      await request(app.getHttpServer())
        .post('/v1/probe/transfers')
        .send(validTransfer)
        .expect(201, validTransfer);
    });

    it('returns problem+json with field errors for an invalid body', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/probe/transfers')
        .send({ amount: '150000', currency: 'naira', destination: {} })
        .expect(400)
        .expect('Content-Type', /application\/problem\+json/);

      const body = response.body as ProblemDetails;
      expect(body).toMatchObject({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        code: 'VALIDATION_ERROR',
        instance: '/v1/probe/transfers',
      });
      expect(body.errors?.map((e) => e.field)).toEqual([
        'amount',
        'currency',
        'destination.accountId',
      ]);
      expect(body.requestId).toBe(response.headers['x-request-id']);
    });

    it('rejects unknown properties', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/probe/transfers')
        .send({ ...validTransfer, fee: 0 })
        .expect(400);

      expect((response.body as ProblemDetails).errors?.[0]?.field).toBe('fee');
    });

    it('returns 400 problem+json for a malformed JSON body', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/probe/transfers')
        .set('Content-Type', 'application/json')
        .send('{"amount": 1,')
        .expect(400)
        .expect('Content-Type', /application\/problem\+json/);

      expect(response.body).toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('returns 413 problem+json for an oversized body', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/probe/transfers')
        .send({ ...validTransfer, padding: 'x'.repeat(200 * 1024) })
        .expect(413);

      expect(response.body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    });

    it('returns domain errors with their own code and status', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/probe/insufficient-funds')
        .expect(422);

      expect(response.body).toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
        detail: 'Available balance is too low',
      });
    });

    it('hides internal details of unexpected errors', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/probe/crash')
        .expect(500);

      expect(response.body).toMatchObject({
        code: 'INTERNAL_ERROR',
        detail: 'An unexpected error occurred',
      });
      expect(response.text).not.toContain('10.0.0.5');
    });

    it('returns problem+json for unknown routes', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/does-not-exist')
        .expect(404)
        .expect('Content-Type', /application\/problem\+json/);

      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('request ids, versioning and headers', () => {
    beforeEach(() => boot());

    it('echoes a valid inbound X-Request-Id', async () => {
      await request(app.getHttpServer())
        .get('/v1/probe/ok')
        .set('X-Request-Id', 'client-req-42')
        .expect('X-Request-Id', 'client-req-42');
    });

    it('replaces an invalid inbound X-Request-Id with a UUID', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/probe/ok')
        .set('X-Request-Id', 'bad id with spaces');

      expect(response.headers['x-request-id']).toMatch(UUID);
    });

    it('serves feature routes only under their version prefix', async () => {
      await request(app.getHttpServer()).get('/v1/probe/ok').expect(200);
      await request(app.getHttpServer()).get('/probe/ok').expect(404);
    });

    it('keeps health probes unversioned', async () => {
      await request(app.getHttpServer()).get('/health/live').expect(200);
    });

    it('sets secure headers', async () => {
      const response = await request(app.getHttpServer()).get('/v1/probe/ok');

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['content-security-policy']).toContain(
        "script-src 'self'",
      );
      expect(response.headers['content-security-policy']).not.toContain(
        'upgrade-insecure-requests',
      );
    });
  });

  describe('rate limiting', () => {
    beforeEach(() =>
      boot({ RATE_LIMIT_MAX: '2', RATE_LIMIT_TTL_SECONDS: '60' }),
    );

    it('returns 429 RATE_LIMITED with Retry-After once the limit is hit', async () => {
      const server = app.getHttpServer();
      await request(server).get('/v1/probe/ok').expect(200);
      await request(server).get('/v1/probe/ok').expect(200);

      const response = await request(server).get('/v1/probe/ok').expect(429);

      expect(response.body).toMatchObject({ code: 'RATE_LIMITED' });
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('never rate limits health probes', async () => {
      const server = app.getHttpServer();
      for (let i = 0; i < 5; i++) {
        await request(server).get('/health/live').expect(200);
      }
    });
  });

  describe('CORS', () => {
    it('is disabled by default', async () => {
      await boot({ CORS_ORIGINS: '' });

      const response = await request(app.getHttpServer())
        .get('/v1/probe/ok')
        .set('Origin', 'https://evil.example.com');

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('allows only configured origins', async () => {
      await boot({ CORS_ORIGINS: 'https://app.example.com' });
      const server = app.getHttpServer();

      const allowed = await request(server)
        .get('/v1/probe/ok')
        .set('Origin', 'https://app.example.com');
      const denied = await request(server)
        .get('/v1/probe/ok')
        .set('Origin', 'https://evil.example.com');

      expect(allowed.headers['access-control-allow-origin']).toBe(
        'https://app.example.com',
      );
      expect(allowed.headers['access-control-expose-headers']).toContain(
        'X-Request-Id',
      );
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
