import { DataSource } from 'typeorm';

/** Empties every entity table so each test starts from a known state. */
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  const tables = dataSource.entityMetadatas
    .map((metadata) => `"${metadata.tableName}"`)
    .join(', ');

  if (tables.length > 0) {
    await dataSource.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  }
}
