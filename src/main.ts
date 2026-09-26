import { Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { appConfig } from './config/app.config';
import { SWAGGER_PATH } from './docs/swagger';
import { AppLogger } from './observability/app-logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Webhook signatures are computed over the exact bytes received.
    rawBody: true,
    // Held until the app logger is ready, so startup logs use its format too.
    bufferLogs: true,
  });
  app.useLogger(app.get(AppLogger));
  const config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);

  configureApp(app);
  app.enableShutdownHooks();

  await app.listen(config.port);

  const logger = new Logger('Bootstrap');
  logger.log(
    `FinStack listening on port ${config.port} (${config.environment})`,
  );
  if (config.swaggerEnabled) {
    logger.log(`API docs at http://localhost:${config.port}/${SWAGGER_PATH}`);
  }
}

void bootstrap();
