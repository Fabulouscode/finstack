import { INestApplication } from '@nestjs/common';
import { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './utils/create-test-app';

describe('Swagger (e2e)', () => {
  let app: INestApplication<App>;
  const originalEnv = process.env;

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
  });

  describe('when enabled', () => {
    let document: OpenAPIObject;

    beforeEach(async () => {
      process.env = { ...originalEnv, SWAGGER_ENABLED: 'true' };
      app = await createTestApp();

      const response = await request(app.getHttpServer())
        .get('/docs-json')
        .expect(200);
      document = response.body as OpenAPIObject;
    });

    it('serves an OpenAPI 3 document describing FinStack', () => {
      expect(document.openapi).toMatch(/^3\./);
      expect(document.info.title).toBe('FinStack API');
    });

    it('declares the bearer token and API key security schemes', () => {
      expect(document.components?.securitySchemes).toMatchObject({
        'access-token': { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'api-key': { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      });
    });

    it('documents the health endpoints with their responses', () => {
      const ready = document.paths['/health/ready']?.get;

      expect(ready?.tags).toEqual(['Health']);
      expect(ready?.summary).toBe('Readiness probe');
      expect(Object.keys(ready?.responses ?? {})).toEqual(
        expect.arrayContaining(['200', '503']),
      );
      expect(document.paths['/health/live']?.get).toBeDefined();
    });

    it('serves the Swagger UI', async () => {
      const response = await request(app.getHttpServer())
        .get('/docs')
        .expect(200);

      expect(response.text).toContain('swagger-ui');
    });
  });

  describe('when disabled', () => {
    beforeEach(async () => {
      process.env = { ...originalEnv, SWAGGER_ENABLED: 'false' };
      app = await createTestApp();
    });

    it('does not expose the docs', async () => {
      await request(app.getHttpServer()).get('/docs-json').expect(404);
      await request(app.getHttpServer()).get('/docs').expect(404);
    });
  });
});
