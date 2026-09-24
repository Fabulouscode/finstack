import { INestApplication } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { appConfig } from './config/app.config';
import { setupSwagger } from './docs/swagger';

/**
 * Applies app-wide HTTP setup. Shared by `main.ts` and the e2e tests so
 * tests exercise exactly what runs in production.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);

  if (config.swaggerEnabled) {
    setupSwagger(app);
  }
}
