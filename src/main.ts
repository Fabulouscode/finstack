import { Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { appConfig } from './config/app.config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);

  app.enableShutdownHooks();

  await app.listen(config.port);
  Logger.log(
    `FinStack listening on port ${config.port} (${config.environment})`,
    'Bootstrap',
  );
}

void bootstrap();
