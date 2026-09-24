import { Module } from '@nestjs/common';
import { HttpModule } from './common/http/http.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [ConfigModule, DatabaseModule, HttpModule, HealthModule],
})
export class AppModule {}
