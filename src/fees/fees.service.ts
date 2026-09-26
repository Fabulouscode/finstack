import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { formatMoney } from '../common/money/format';
import { calculateFee } from './fee-math';
import { FeeOperation, FeeRule } from './fee-rule.entity';
import {
  AmountBelowFeeException,
  FeeRuleAlreadyRetiredException,
  FeeRuleNotFoundException,
} from './fees.errors';

export interface FeeQuote {
  /** Minor units of `currency`; 0 when no rule applies. */
  amount: bigint;
  currency: string;
  ruleId: string | null;
}

export interface NewFeeRule {
  operation: FeeOperation;
  currency: string;
  organizationId?: string | null;
  fixedAmount: bigint;
  percentageBps: number;
  minAmount: bigint;
  maxAmount: bigint | null;
}

/**
 * Fees are data, not code: rules per operation and currency, with
 * per-organization overrides. An organization's rule wins over the
 * platform default; no rule means no fee.
 */
@Injectable()
export class FeesService {
  constructor(
    @InjectRepository(FeeRule) private readonly rules: Repository<FeeRule>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** The fee for `amount` (minor units of `currency`) under the active rule. */
  async quote(input: {
    operation: FeeOperation;
    currency: string;
    amount: bigint;
    organizationId?: string | null;
  }): Promise<FeeQuote> {
    const rule = await this.activeRule(
      input.operation,
      input.currency,
      input.organizationId ?? null,
    );
    return {
      amount: rule ? calculateFee(input.amount, rule) : 0n,
      currency: input.currency,
      ruleId: rule?.id ?? null,
    };
  }

  /** quote(), refusing amounts the fee would consume entirely. */
  async quoteCovered(input: {
    operation: FeeOperation;
    currency: string;
    amount: bigint;
    organizationId?: string | null;
  }): Promise<FeeQuote> {
    const fee = await this.quote(input);
    if (fee.amount >= input.amount && fee.amount > 0n) {
      throw new AmountBelowFeeException(formatMoney(fee.amount, fee.currency));
    }
    return fee;
  }

  /** Creates the rule for its scope, superseding the active one. Audited. */
  async setRule(adminId: string, input: NewFeeRule): Promise<FeeRule> {
    return this.dataSource.transaction(async (manager) => {
      const organizationId = input.organizationId ?? null;
      // Serialise changes to one scope, so two admins can't both "win".
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `fee-rule:${input.operation}:${input.currency}:${organizationId ?? '*'}`,
      ]);
      const previous = await manager.findOneBy(FeeRule, {
        operation: input.operation,
        currency: input.currency,
        organizationId: organizationId ?? IsNull(),
        supersededAt: IsNull(),
      });
      if (previous) {
        await manager.update(FeeRule, previous.id, {
          supersededAt: new Date(),
        });
      }
      const rule = await manager.save(
        manager.create(FeeRule, {
          ...input,
          organizationId,
          createdByUserId: adminId,
          supersededAt: null,
        }),
      );
      await this.audit.record(manager, {
        action: AuditAction.FeeRuleSet,
        organizationId,
        targetType: 'fee_rule',
        targetId: rule.id,
        metadata: {
          operation: rule.operation,
          currency: rule.currency,
          fixedAmount: rule.fixedAmount.toString(),
          percentageBps: rule.percentageBps,
          minAmount: rule.minAmount.toString(),
          maxAmount: rule.maxAmount?.toString() ?? null,
          replaces: previous?.id ?? null,
        },
      });
      return rule;
    });
  }

  /** Ends a rule without a replacement (falls back to the default, or free). */
  async retire(ruleId: string): Promise<FeeRule> {
    await this.dataSource.transaction(async (manager) => {
      const rule = await manager.findOneBy(FeeRule, { id: ruleId });
      if (!rule) {
        throw new FeeRuleNotFoundException();
      }
      const result = await manager.update(
        FeeRule,
        { id: ruleId, supersededAt: IsNull() },
        { supersededAt: new Date() },
      );
      if (!result.affected) {
        throw new FeeRuleAlreadyRetiredException();
      }
      await this.audit.record(manager, {
        action: AuditAction.FeeRuleRetired,
        organizationId: rule.organizationId,
        targetType: 'fee_rule',
        targetId: rule.id,
      });
    });
    return this.rules.findOneByOrFail({ id: ruleId });
  }

  list(filter: {
    operation?: FeeOperation;
    currency?: string;
    organizationId?: string;
    includeHistory: boolean;
  }): Promise<FeeRule[]> {
    return this.rules.find({
      where: {
        ...(filter.operation ? { operation: filter.operation } : {}),
        ...(filter.currency ? { currency: filter.currency } : {}),
        ...(filter.organizationId
          ? { organizationId: filter.organizationId }
          : {}),
        ...(filter.includeHistory ? {} : { supersededAt: IsNull() }),
      },
      order: { createdAt: 'DESC' },
      take: 500,
    });
  }

  private async activeRule(
    operation: FeeOperation,
    currency: string,
    organizationId: string | null,
  ): Promise<FeeRule | null> {
    if (organizationId) {
      const own = await this.rules.findOneBy({
        operation,
        currency,
        organizationId,
        supersededAt: IsNull(),
      });
      if (own) return own;
    }
    return this.rules.findOneBy({
      operation,
      currency,
      organizationId: IsNull(),
      supersededAt: IsNull(),
    });
  }
}
