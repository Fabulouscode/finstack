import { ConsoleLogger, INestApplication, Type } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { resetQueues } from './queues';

/** Boots the full application with the same HTTP setup as `main.ts`. */
export async function createTestApp(
  options: { controllers?: Type[] } = {},
): Promise<INestApplication<App>> {
  const builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  });
  // Nest's testing logger only prints errors. E2E_LOGS=debug shows everything,
  // which helps when chasing an intermittent failure.
  if (process.env.E2E_LOGS === 'debug') {
    builder.setLogger(new ConsoleLogger());
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  configureApp(app);
  await app.init();
  await resetQueues(app);

  return app;
}
