import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { TransactionsService } from '../../transactions/transactions.service';
import { AdminMoneyFilter } from './admin-list-query.dto';

/**
 * Applies the shared admin filters to a query over a money table (payments,
 * refunds, payouts). Status lives on the transaction, so it goes through
 * TransactionsService.statusIn rather than another module's table.
 * Owner filters apply only to tables with owner columns.
 */
export function applyMoneyFilter<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  alias: string,
  filter: AdminMoneyFilter,
  transactions: TransactionsService,
): void {
  if (filter.status) {
    query.andWhere(
      transactions.statusIn(`${alias}.transaction_id`, [filter.status]),
    );
  }
  if (filter.provider) {
    query.andWhere(`${alias}.provider = :provider`, {
      provider: filter.provider,
    });
  }
  if (filter.currency) {
    query.andWhere(`${alias}.currency = :currency`, {
      currency: filter.currency,
    });
  }
  if (filter.userId) {
    query.andWhere(`${alias}.userId = :userId`, { userId: filter.userId });
  }
  if (filter.organizationId) {
    query.andWhere(`${alias}.organizationId = :organizationId`, {
      organizationId: filter.organizationId,
    });
  }
}
