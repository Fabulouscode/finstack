import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseConfig } from '../src/config/database.config';
import { buildDataSourceOptions } from '../src/database/typeorm-options';
import './setup-env';

/**
 * Brings the test database schema up to date once per run, using the real
 * migrations (never `synchronize`), so tests exercise the production schema.
 */
export default async function globalSetup(): Promise<void> {
  const dataSource = new DataSource(buildDataSourceOptions(databaseConfig()));
  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: 'each' });
  } finally {
    await dataSource.destroy();
  }
}
