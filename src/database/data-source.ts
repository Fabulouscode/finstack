import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { databaseConfig } from '../config/database.config';
import { buildDataSourceOptions, ENTITIES_GLOB } from './typeorm-options';

/**
 * DataSource used by the TypeORM CLI (migrations). The Nest application
 * builds its connection in DatabaseModule from the same options.
 */
loadEnv({ quiet: true });

export default new DataSource({
  ...buildDataSourceOptions(databaseConfig()),
  entities: [ENTITIES_GLOB],
});
