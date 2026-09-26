import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { formatMoney } from '../common/money/format';
import { Owner, OwnerRef, toOwner } from '../common/owner/owner';
import { TransactionType } from '../transactions/transaction.types';
import { TransactionsService } from '../transactions/transactions.service';
import { LimitOperation, LimitRule } from './limit-rule.entity';
import {
  LimitExceededException,
  LimitRuleAlreadyRetiredException,
  LimitRuleNotFoundException,
} from './limits.errors';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

const TRANSACTION_TYPES: Record<LimitOperation, TransactionType> = {
  [LimitOperation.Payment]: TransactionType.Payment,
  [LimitOperation.Payout]: TransactionType.Withdrawal,
  [LimitOperation.Transfer]: TransactionType.Transfer,
};

export interface NewLimitRule {
  operation: LimitOperation;
  currency: string;
  organizationId?: string | null;
  maxPerTransaction: bigint | null;
  maxDailyAmount: bigint | null;
  maxDailyCount: number | null;
  maxMonthlyAmount: bigint | null;
}

export interface LimitUsage {
  rule: LimitRule;
  daily: { amount: bigint; count: number };
  monthly: { amount: bigint };
}

/**
 * Velocity limits: how much an owner may move per operation and currency.
 * Checked inside the database transaction that creates the payment,
 * payout or transfer, under a per-owner lock, so concurrent requests can't
 * together exceed a limit.
 */
@Injectable()
export class LimitsService {
  constructor(
    @InjectRepository(LimitRule) private readonly rules: Repository<LimitRule>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Throws LIMIT_EXCEEDED if `amount` would break a limit. Call inside the
   * transaction that records the operation, before recording it.
   */
  async assertWithinLimitsWithin(
    manager: EntityManager,
    input: {
      owner: OwnerRef;
      operation: LimitOperation;
      currency: string;
      amount: bigint;
    },
  ): Promise<void> {
    const owner = toOwner(input.owner);
    const rule = await this.activeRule(input.operation, input.currency, owner);
    if (!rule) {
      return;
    }
    const money = (value: bigint): string => formatMoney(value, input.currency);

    if (
      rule.maxPerTransaction !== null &&
      input.amount > rule.maxPerTransaction
    ) {
      throw new LimitExceededException(
        `The ${input.operation} limit is ${money(rule.maxPerTransaction)} per transaction`,
      );
    }
    if (
      rule.maxDailyAmount === null &&
      rule.maxDailyCount === null &&
      rule.maxMonthlyAmount === null
    ) {
      return;
    }

    // Serialises this owner's operations of this kind until commit, so the
    // usage read below can't be raced by a concurrent request.
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `limits:${owner.kind}:${owner.id}:${input.operation}:${input.currency}`,
    ]);
    const { daily, monthly } = await this.usage(manager, owner, rule);

    if (rule.maxDailyCount !== null && daily.count + 1 > rule.maxDailyCount) {
      throw new LimitExceededException(
        `The ${input.operation} limit is ${rule.maxDailyCount} per 24 hours`,
      );
    }
    if (
      rule.maxDailyAmount !== null &&
      daily.amount + input.amount > rule.maxDailyAmount
    ) {
      throw new LimitExceededException(
        `This would exceed the ${input.operation} limit of ${money(rule.maxDailyAmount)} per 24 hours ` +
          `(${money(rule.maxDailyAmount - daily.amount > 0n ? rule.maxDailyAmount - daily.amount : 0n)} left)`,
      );
    }
    if (
      rule.maxMonthlyAmount !== null &&
      monthly.amount + input.amount > rule.maxMonthlyAmount
    ) {
      throw new LimitExceededException(
        `This would exceed the ${input.operation} limit of ${money(rule.maxMonthlyAmount)} per 30 days ` +
          `(${money(rule.maxMonthlyAmount - monthly.amount > 0n ? rule.maxMonthlyAmount - monthly.amount : 0n)} left)`,
      );
    }
  }

  /** The limits that apply to an owner, with what has been used. */
  async usageFor(ownerRef: OwnerRef): Promise<LimitUsage[]> {
    const owner = toOwner(ownerRef);
    const candidates = await this.rules.find({
      where: [
        { organizationId: IsNull(), supersededAt: IsNull() },
        ...(owner.kind === 'organization'
          ? [{ organizationId: owner.id, supersededAt: IsNull() }]
          : []),
      ],
      order: { operation: 'ASC', currency: 'ASC' },
    });
    // An organization's own rule replaces the default for that scope.
    const effective = new Map<string, LimitRule>();
    for (const rule of candidates) {
      const key = `${rule.operation}:${rule.currency}`;
      if (!effective.has(key) || rule.organizationId) {
        effective.set(key, rule);
      }
    }
    const usages: LimitUsage[] = [];
    for (const rule of effective.values()) {
      usages.push({
        rule,
        ...(await this.usage(this.dataSource.manager, owner, rule)),
      });
    }
    return usages;
  }

  /** Creates the rule for its scope, superseding the active one. Audited. */
  async setRule(adminId: string, input: NewLimitRule): Promise<LimitRule> {
    return this.dataSource.transaction(async (manager) => {
      const organizationId = input.organizationId ?? null;
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `limit-rule:${input.operation}:${input.currency}:${organizationId ?? '*'}`,
      ]);
      const previous = await manager.findOneBy(LimitRule, {
        operation: input.operation,
        currency: input.currency,
        organizationId: organizationId ?? IsNull(),
        supersededAt: IsNull(),
      });
      if (previous) {
        await manager.update(LimitRule, previous.id, {
          supersededAt: new Date(),
        });
      }
      const rule = await manager.save(
        manager.create(LimitRule, {
          ...input,
          organizationId,
          createdByUserId: adminId,
          supersededAt: null,
        }),
      );
      await this.audit.record(manager, {
        action: AuditAction.LimitRuleSet,
        organizationId,
        targetType: 'limit_rule',
        targetId: rule.id,
        metadata: {
          operation: rule.operation,
          currency: rule.currency,
          maxPerTransaction: rule.maxPerTransaction?.toString() ?? null,
          maxDailyAmount: rule.maxDailyAmount?.toString() ?? null,
          maxDailyCount: rule.maxDailyCount,
          maxMonthlyAmount: rule.maxMonthlyAmount?.toString() ?? null,
          replaces: previous?.id ?? null,
        },
      });
      return rule;
    });
  }

  async retire(ruleId: string): Promise<LimitRule> {
    await this.dataSource.transaction(async (manager) => {
      const rule = await manager.findOneBy(LimitRule, { id: ruleId });
      if (!rule) {
        throw new LimitRuleNotFoundException();
      }
      const result = await manager.update(
        LimitRule,
        { id: ruleId, supersededAt: IsNull() },
        { supersededAt: new Date() },
      );
      if (!result.affected) {
        throw new LimitRuleAlreadyRetiredException();
      }
      await this.audit.record(manager, {
        action: AuditAction.LimitRuleRetired,
        organizationId: rule.organizationId,
        targetType: 'limit_rule',
        targetId: rule.id,
      });
    });
    return this.rules.findOneByOrFail({ id: ruleId });
  }

  list(filter: {
    operation?: LimitOperation;
    currency?: string;
    organizationId?: string;
    includeHistory: boolean;
  }): Promise<LimitRule[]> {
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

  private async usage(
    manager: EntityManager,
    owner: Owner,
    rule: LimitRule,
  ): Promise<Omit<LimitUsage, 'rule'>> {
    const type = TRANSACTION_TYPES[rule.operation];
    const now = Date.now();
    const daily = await this.transactions.usageWithin(
      manager,
      owner,
      type,
      rule.currency,
      new Date(now - DAY_MS),
    );
    const monthly =
      rule.maxMonthlyAmount === null
        ? { amount: 0n }
        : await this.transactions.usageWithin(
            manager,
            owner,
            type,
            rule.currency,
            new Date(now - MONTH_MS),
          );
    return { daily, monthly: { amount: monthly.amount } };
  }

  private async activeRule(
    operation: LimitOperation,
    currency: string,
    owner: Owner,
  ): Promise<LimitRule | null> {
    if (owner.kind === 'organization') {
      const own = await this.rules.findOneBy({
        operation,
        currency,
        organizationId: owner.id,
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
