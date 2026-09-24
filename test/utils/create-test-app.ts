import { INestApplication, Type } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';

/** Boots the full application with the same HTTP setup as `main.ts`. */
export async function createTestApp(
  options: { controllers?: Type[] } = {},
): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  configureApp(app);
  await app.init();

  return app;
}
