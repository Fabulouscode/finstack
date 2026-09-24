import { DatabaseConfig } from '../config/database.config';
import { SnakeNamingStrategy } from './snake-naming.strategy';
import { buildDataSourceOptions, MIGRATIONS_GLOB } from './typeorm-options';

describe('buildDataSourceOptions', () => {
  const config: DatabaseConfig = {
    host: 'db.internal',
    port: 5432,
    user: 'finstack',
    password: 'secret',
    name: 'finstack',
    ssl: false,
    logging: false,
    poolMax: 15,
  };

  it('maps config to PostgreSQL connection options', () => {
    expect(buildDataSourceOptions(config)).toMatchObject({
      type: 'postgres',
      host: 'db.internal',
      port: 5432,
      username: 'finstack',
      password: 'secret',
      database: 'finstack',
      applicationName: 'finstack',
      extra: { max: 15 },
    });
  });

  it('never synchronizes the schema or auto-runs migrations', () => {
    const options = buildDataSourceOptions(config);

    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(false);
  });

  it('uses snake_case naming', () => {
    expect(buildDataSourceOptions(config).namingStrategy).toBeInstanceOf(
      SnakeNamingStrategy,
    );
  });

  it('verifies server certificates when SSL is enabled', () => {
    expect(buildDataSourceOptions({ ...config, ssl: true }).ssl).toEqual({
      rejectUnauthorized: true,
    });
    expect(buildDataSourceOptions(config).ssl).toBe(false);
  });

  it('only matches migration files of the running extension', () => {
    expect(MIGRATIONS_GLOB).toMatch(/migrations[/\\]\*\.ts$/);
  });
});
