import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { Cursor } from './cursor';

export interface PageOptions {
  limit: number;
  before?: Cursor;
}

/**
 * One page of `query`, newest first, by (createdAt, id): keyset pagination,
 * so pages stay stable while rows are added and deep pages stay fast.
 * `alias` is the query's root alias; the entity needs `id` and `createdAt`.
 */
export async function keysetPage<
  T extends ObjectLiteral & { id: string; createdAt: Date },
>(
  query: SelectQueryBuilder<T>,
  alias: string,
  options: PageOptions,
): Promise<{ items: T[]; next: Cursor | null }> {
  query
    .orderBy(`${alias}.createdAt`, 'DESC')
    .addOrderBy(`${alias}.id`, 'DESC')
    .limit(options.limit + 1);
  if (options.before) {
    query.andWhere(
      `(${alias}.createdAt, ${alias}.id) < (:beforeCreatedAt, :beforeId)`,
      {
        beforeCreatedAt: options.before.createdAt,
        beforeId: options.before.id,
      },
    );
  }
  const rows = await query.getMany();
  const items = rows.slice(0, options.limit);
  const last = items.at(-1);
  return {
    items,
    next:
      rows.length > options.limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  };
}
