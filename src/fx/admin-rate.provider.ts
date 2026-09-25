import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrencyCode } from '../common/money/currency';
import { FxRate } from './fx-rate.entity';
import { formatRate, parseRate } from './fx-math';
import { RateProvider, RateSnapshot } from './rate-provider';

export const ADMIN_RATE_SOURCE = 'admin';

/** Serves the newest admin-set rate for a pair, in either orientation. */
@Injectable()
export class AdminRateProvider implements RateProvider {
  constructor(
    @InjectRepository(FxRate)
    private readonly rates: Repository<FxRate>,
    private readonly audit: AuditService,
  ) {}

  async getRate(
    a: CurrencyCode,
    b: CurrencyCode,
  ): Promise<RateSnapshot | null> {
    const latest = await this.rates
      .createQueryBuilder('rate')
      .where(
        '(rate.baseCurrency = :a AND rate.quoteCurrency = :b) OR (rate.baseCurrency = :b AND rate.quoteCurrency = :a)',
        { a, b },
      )
      .orderBy('rate.createdAt', 'DESC')
      .addOrderBy('rate.id', 'DESC')
      .limit(1)
      .getOne();

    if (!latest) return null;

    return {
      rateId: latest.id,
      base: latest.baseCurrency as CurrencyCode,
      quote: latest.quoteCurrency as CurrencyCode,
      rate: formatRate(parseRate(latest.rate)),
      asOf: latest.createdAt,
    };
  }

  async setRate(input: {
    base: CurrencyCode;
    quote: CurrencyCode;
    rate: string;
    userId: string | null;
  }): Promise<FxRate> {
    return this.rates.manager.transaction(async (manager) => {
      const rate = await manager.save(
        manager.create(FxRate, {
          baseCurrency: input.base,
          quoteCurrency: input.quote,
          rate: formatRate(parseRate(input.rate)),
          source: ADMIN_RATE_SOURCE,
          createdByUserId: input.userId,
        }),
      );
      await this.audit.record(manager, {
        action: AuditAction.FxRateSet,
        targetType: 'fx_rate',
        targetId: rate.id,
        metadata: {
          pair: `${rate.baseCurrency}/${rate.quoteCurrency}`,
          rate: rate.rate,
        },
      });
      return rate;
    });
  }

  /** Newest rate of every pair (one row per unordered pair). */
  async listCurrent(): Promise<FxRate[]> {
    return this.rates.query(
      `SELECT DISTINCT ON (LEAST(base_currency, quote_currency), GREATEST(base_currency, quote_currency))
              id, base_currency AS "baseCurrency", quote_currency AS "quoteCurrency",
              rate, source, created_at AS "createdAt"
         FROM fx_rates
        ORDER BY LEAST(base_currency, quote_currency), GREATEST(base_currency, quote_currency),
                 created_at DESC, id DESC`,
    );
  }
}
