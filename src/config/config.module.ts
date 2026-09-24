import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { appConfig } from './app.config';
import { authConfig } from './auth.config';
import { databaseConfig } from './database.config';
import { httpConfig } from './http.config';

/**
 * Loads `.env` (if present) and registers every validated config namespace.
 *
 * Global so feature modules can inject their namespace with
 * `@Inject(appConfig.KEY)` without re-importing this module.
 */
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig, authConfig, databaseConfig, httpConfig],
    }),
  ],
})
export class ConfigModule {}
