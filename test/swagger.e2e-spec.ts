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

    it('gives every nullable field a real type, so generated clients are correct', () => {
      // `string | null` can't be inferred by the Swagger decorators, which then
      // describe the field as an object; clients would get the wrong type.
      const untyped = Object.entries(
        document.components?.schemas ?? {},
      ).flatMap(([schema, definition]) =>
        Object.entries(
          (definition as { properties?: Record<string, object> }).properties ??
            {},
        )
          .filter(([, property]) => {
            const p = property as Record<string, unknown>;
            return (
              p.nullable === true &&
              p.type === 'object' &&
              !p.allOf &&
              !p.properties &&
              !p.additionalProperties
            );
          })
          .map(([name]) => `${schema}.${name}`),
      );
      expect(untyped).toEqual([]);
    });

    it('documents each header once per operation', () => {
      // Header names are case-insensitive: two entries would make generated
      // clients send the header twice, merged into one broken value.
      const duplicated = Object.entries(document.paths).flatMap(
        ([path, operations]) =>
          Object.entries(
            operations as Record<
              string,
              { parameters?: { in: string; name: string }[] }
            >,
          )
            .filter(([, operation]) => {
              const headers = (operation.parameters ?? [])
                .filter((parameter) => parameter.in === 'header')
                .map((parameter) => parameter.name.toLowerCase());
              return new Set(headers).size !== headers.length;
            })
            .map(([method]) => `${method.toUpperCase()} ${path}`),
      );
      expect(duplicated).toEqual([]);
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
