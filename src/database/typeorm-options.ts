import { extname, join } from 'node:path';
import { DataSourceOptions } from 'typeorm';
import { DatabaseConfig } from '../config/database.config';
import { SnakeNamingStrategy } from './snake-naming.strategy';

type PostgresDataSourceOptions = Extract<
  DataSourceOptions,
  { type: 'postgres' }
>;

// `.ts` when running from source (tests), `.js` when running from `dist/`.
// Matching on the current extension avoids picking up `.d.ts` files in `dist/`.
const fileExtension = extname(__filename);

export const MIGRATIONS_GLOB = join(
  __dirname,
  'migrations',
  `*${fileExtension}`,
);
export const ENTITIES_GLOB = join(
  __dirname,
  '..',
  '**',
  `*.entity${fileExtension}`,
);

/**
 * Single source of truth for connection settings, shared by the Nest
 * application and the TypeORM CLI so migrations always run with the same
 * options as the app.
 */
export function buildDataSourceOptions(
  config: DatabaseConfig,
): PostgresDataSourceOptions {
  return {
    type: 'postgres',
    host: config.host,
    port: config.port,
    username: config.user,
    password: config.password,
    database: config.name,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    logging: config.logging,
    applicationName: 'finstack',
    namingStrategy: new SnakeNamingStrategy(),
    // Schema changes only ever happen through reviewed migrations.
    synchronize: false,
    migrationsRun: false,
    migrations: [MIGRATIONS_GLOB],
    extra: {
      max: config.poolMax,
    },
  };
}
