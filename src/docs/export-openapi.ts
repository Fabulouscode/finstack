import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { writeFileSync } from 'node:fs';
import { AppModule } from '../app.module';
import { buildOpenApiDocument } from './swagger';

/**
 * Writes the OpenAPI spec to a file without starting the app: preview mode
 * builds the route table without connecting to PostgreSQL or Redis. Clients
 * (such as the admin dashboard) generate their types from this file.
 *
 *   npm run openapi            # writes openapi.json
 *   npm run openapi -- --check # fails if openapi.json is out of date
 */
async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    preview: true,
    logger: false,
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  const spec = `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`;
  await app.close();

  const file = 'openapi.json';
  if (process.argv.includes('--check')) {
    const { readFileSync, existsSync } = await import('node:fs');
    if (!existsSync(file) || readFileSync(file, 'utf8') !== spec) {
      console.error(
        `${file} is out of date: run npm run openapi and commit it`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`${file} is up to date`);
    return;
  }
  writeFileSync(file, spec);
  console.log(`Wrote ${file}`);
}

void main();
