import { ConsoleLogger, INestApplication, Type } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { resetQueues } from './queues';

let appCounter = 0;

/** The id of the most recently created test app (see X-Test-App). */
export function currentTestAppId(): number {
  return appCounter;
}

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
  // Tags every response with the app instance that produced it, so a failure
  // shows whether the request reached the current test's app.
  const appId = ++appCounter;
  app.use(
    (
      _req: unknown,
      res: { setHeader(n: string, v: string): void },
      next: () => void,
    ) => {
      res.setHeader('X-Test-App', String(appId));
      next();
    },
  );
  configureApp(app);
  await app.init();
  // Listen on loopback explicitly, once. Left to supertest, the app would
  // listen on the IPv6 wildcard on a new random port for every request, and
  // on macOS that port can coincide with another program listening on
  // 127.0.0.1 (editors, desktop apps): supertest connects to 127.0.0.1 and
  // the other program answers (seen as sporadic 401/404/500 without our
  // X-Request-Id). Binding 127.0.0.1 makes the kernel pick a port that is
  // really free there.
  await app.listen(0, '127.0.0.1');
  await resetQueues(app);

  return app;
}
