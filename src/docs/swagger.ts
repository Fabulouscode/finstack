import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export const SWAGGER_PATH = 'docs';
export const SWAGGER_JSON_PATH = 'docs-json';

/**
 * Security scheme names. Reference them from controllers, e.g.
 * `@ApiBearerAuth(ACCESS_TOKEN_SCHEME)` or `@ApiSecurity(API_KEY_SCHEME)`.
 */
export const ACCESS_TOKEN_SCHEME = 'access-token';
export const API_KEY_SCHEME = 'api-key';
export const API_KEY_HEADER = 'X-API-Key';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('FinStack API')
    .setDescription(
      [
        'Production-minded fintech backend starter: wallets, double-entry ledger, payments, webhooks, idempotency and reconciliation.',
        '',
        '**Money** is always an integer in minor units (e.g. kobo, cents) paired with an ISO 4217 currency code.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .setLicense('MIT', 'https://opensource.org/licenses/MIT')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Short-lived access token issued by the auth endpoints.',
      },
      ACCESS_TOKEN_SCHEME,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: API_KEY_HEADER,
        description: 'Secret API key for server-to-server integrations.',
      },
      API_KEY_SCHEME,
    )
    .addTag('Health', 'Liveness and readiness probes')
    .build();

  return SwaggerModule.createDocument(app, config);
}

/** Serves Swagger UI at `/docs` and the raw OpenAPI document at `/docs-json`. */
export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup(SWAGGER_PATH, app, () => buildOpenApiDocument(app), {
    jsonDocumentUrl: SWAGGER_JSON_PATH,
    yamlDocumentUrl: 'docs-yaml',
    customSiteTitle: 'FinStack API',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
    },
  });
}
