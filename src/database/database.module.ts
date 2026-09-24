import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseConfig, databaseConfig } from '../config/database.config';
import { buildDataSourceOptions } from './typeorm-options';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [databaseConfig.KEY],
      useFactory: (config: DatabaseConfig) => ({
        ...buildDataSourceOptions(config),
        // Entities are registered per feature module via TypeOrmModule.forFeature().
        autoLoadEntities: true,
      }),
    }),
  ],
})
export class DatabaseModule {}
