import { DataSource } from 'typeorm';
import { databaseConfig } from '../../src/config/database.config';
import { buildDataSourceOptions } from '../../src/database/typeorm-options';

describe('Database (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource(buildDataSourceOptions(databaseConfig()));
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('connects to the dedicated test database', async () => {
    const [row] = await dataSource.query<{ database: string }[]>(
      'SELECT current_database() AS database',
    );

    expect(row?.database).toBe('finstack_test');
  });

  it('identifies itself to PostgreSQL for observability', async () => {
    const [row] = await dataSource.query<{ name: string }[]>(
      "SELECT current_setting('application_name') AS name",
    );

    expect(row?.name).toBe('finstack');
  });

  it('runs pending migrations idempotently', async () => {
    await dataSource.runMigrations({ transaction: 'each' });

    await expect(dataSource.showMigrations()).resolves.toBe(false);
  });

  it('rolls back every statement when a transaction fails', async () => {
    await dataSource.query(
      'CREATE TEMP TABLE rollback_probe (id int PRIMARY KEY) ON COMMIT PRESERVE ROWS',
    );

    await expect(
      dataSource.transaction(async (manager) => {
        await manager.query('INSERT INTO rollback_probe (id) VALUES (1)');
        await manager.query('INSERT INTO rollback_probe (id) VALUES (1)');
      }),
    ).rejects.toThrow(/duplicate key/);

    const rows = await dataSource.query<unknown[]>(
      'SELECT id FROM rollback_probe',
    );
    expect(rows).toHaveLength(0);
  });
});
