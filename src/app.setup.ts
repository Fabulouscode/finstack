import { VersioningType } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import {
  REQUEST_ID_HEADER,
  requestIdMiddleware,
} from './common/request-context/request-id.middleware';
import { appConfig } from './config/app.config';
import { httpConfig } from './config/http.config';
import { setupSwagger } from './docs/swagger';

/**
 * Applies app-wide HTTP setup. Shared by `main.ts` and the e2e tests so
 * tests exercise exactly what runs in production.
 *
 * Global pipes, filters and guards live in HttpModule as DI providers; this
 * function only covers what must be configured on the underlying server.
 */
export function configureApp(app: NestExpressApplication): void {
  const appSettings = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  const http = app.get<ConfigType<typeof httpConfig>>(httpConfig.KEY);

  // First, so every later middleware, log line and error carries the ID.
  app.use(requestIdMiddleware);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Upgrading to HTTPS breaks Swagger UI on plain-HTTP dev hosts
          // (e.g. a LAN IP); production is expected to be served over TLS.
          upgradeInsecureRequests: appSettings.isProduction ? [] : null,
        },
      },
    }),
  );

  if (http.trustProxyHops > 0) {
    app.set('trust proxy', http.trustProxyHops);
  }

  if (http.corsOrigins.length > 0) {
    const allowAll = http.corsOrigins.includes('*');
    app.enableCors({
      origin: allowAll ? '*' : http.corsOrigins,
      credentials: !allowAll,
      exposedHeaders: [REQUEST_ID_HEADER, 'Retry-After'],
    });
  }

  // Feature routes are served under /v1/...; health probes opt out.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  if (appSettings.swaggerEnabled) {
    setupSwagger(app);
  }
}
