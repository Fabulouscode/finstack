import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import type { Cursor } from '../common/pagination/cursor';
import { isUniqueViolation } from '../database/postgres-errors';
import { LedgerService } from '../ledger/ledger.service';
import { OutboxService } from '../outbox/outbox.service';
import {
  PaymentProviderError,
  ProviderPaymentRecord,
  ProviderPayoutRecord,
  ProviderPayoutStatus,
  ReconciliationCapability,
  TimeRange,
} from '../payment-providers/payment-provider';
import { PaymentProvidersService } from '../payment-providers/payment-providers.service';
import { PaymentSettlementService } from '../payments/payment-settlement.service';
import { Payment } from '../payments/payment.entity';
import { PaymentsService } from '../payments/payments.service';
import { Payout } from '../payouts/payout.entity';
import { PayoutsService } from '../payouts/payouts.service';
import { Transaction } from '../transactions/transaction.entity';
import { TransactionStatus } from '../transactions/transaction.types';
import { TransactionsService } from '../transactions/transactions.service';
import {
  ReconciliationIssue,
  ReconciliationItem,
  ReconciliationItemKind,
  ReconciliationItemStatus,
} from './reconciliation-item.entity';
import {
  ReconciliationRun,
  ReconciliationRunStatus,
  ReconciliationSummary,
  ReconciliationTrigger,
} from './reconciliation-run.entity';
import {
  ProviderCannotReconcileException,
  ReconciliationItemNotFoundException,
  ReconciliationItemNotOpenException,
  ReconciliationRunNotFoundException,
} from './reconciliation.errors';

type NewItem = Pick<
  ReconciliationItem,
  'kind' | 'issue' | 'reference' | 'targetId' | 'finstack' | 'provider'
> & { status?: ReconciliationItemStatus };

/** Collected, as far as the money is concerned (a refund came later). */
const COLLECTED = new Set(['successful', 'refunded']);
const CREDITED = new Set<TransactionStatus>([
  TransactionStatus.Successful,
  TransactionStatus.Reversed,
]);
const OPEN_PAYMENT = new Set<TransactionStatus>([
  TransactionStatus.Pending,
  TransactionStatus.Processing,
]);

/** Which provider payout status each FinStack payout status agrees with. */
const PAYOUT_AGREES: Record<string, ProviderPayoutStatus> = {
  [TransactionStatus.Processing]: 'pending',
  [TransactionStatus.Successful]: 'successful',
  [TransactionStatus.Failed]: 'failed',
  [TransactionStatus.Reversed]: 'reversed',
};

export interface ItemPage {
  items: ReconciliationItem[];
  next: Cursor | null;
}

/**
 * Compares FinStack's payments and payouts with the provider's records for
 * a period, and the ledger with itself. Differences become items for a
 * person to resolve. Only late webhooks are fixed automatically, through the
 * normal settlement paths (which re-verify with the provider).
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @InjectRepository(ReconciliationRun)
    private readonly runs: Repository<ReconciliationRun>,
    @InjectRepository(ReconciliationItem)
    private readonly items: Repository<ReconciliationItem>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly providers: PaymentProvidersService,
    private readonly settlement: PaymentSettlementService,
    private readonly payments: PaymentsService,
    private readonly payouts: PayoutsService,
    private readonly transactions: TransactionsService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  /** Providers that can list their records. */
  reconcilableProviders(): string[] {
    return this.providers
      .enabledNames()
      .filter((name) => this.providers.get(name).reconciliation);
  }

  /**
   * Creates a run. Scheduled runs are unique per check and period, so a
   * duplicate returns null instead.
   */
  async createRun(input: {
    provider: string | null;
    range: TimeRange;
    trigger: ReconciliationTrigger;
    requestedByUserId?: string;
  }): Promise<ReconciliationRun | null> {
    if (input.provider && !this.providers.get(input.provider).reconciliation) {
      throw new ProviderCannotReconcileException(input.provider);
    }
    try {
      return await this.runs.save(
        this.runs.create({
          provider: input.provider,
          periodStart: input.range.from,
          periodEnd: input.range.to,
          status: ReconciliationRunStatus.Running,
          trigger: input.trigger,
          requestedByUserId: input.requestedByUserId ?? null,
          summary: {},
          error: null,
          finishedAt: null,
        }),
      );
    } catch (error) {
      if (
        isUniqueViolation(error, [
          'uq_reconciliation_runs_scheduled_provider',
          'uq_reconciliation_runs_scheduled_ledger',
        ])
      ) {
        return null;
      }
      throw error;
    }
  }

  /** The daily job: yesterday (UTC) for every provider, plus the ledger. */
  async runScheduled(now = new Date()): Promise<ReconciliationRun[]> {
    const to = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const range = { from: new Date(to.getTime() - 86_400_000), to };
    const finished: ReconciliationRun[] = [];
    for (const provider of [null, ...this.reconcilableProviders()]) {
      const run = await this.createRun({
        provider,
        range,
        trigger: ReconciliationTrigger.Schedule,
      });
      if (run) finished.push(await this.execute(run.id));
    }
    return finished;
  }

  /** Performs a run. Never throws for provider problems: the run fails instead. */
  async execute(runId: string): Promise<ReconciliationRun> {
    const run = await this.getRun(runId);
    if (run.status !== ReconciliationRunStatus.Running) {
      return run;
    }
    const range = { from: run.periodStart, to: run.periodEnd };
    const found: NewItem[] = [];
    const summary: ReconciliationSummary = {};

    try {
      if (run.provider) {
        const capability = this.providers.get(run.provider).reconciliation;
        if (!capability) {
          throw new ProviderCannotReconcileException(run.provider);
        }
        summary.paymentsChecked = await this.reconcilePayments(
          run.provider,
          capability,
          range,
          found,
        );
        if (
          capability.listPayouts &&
          this.providers.get(run.provider).payouts
        ) {
          summary.payoutsChecked = await this.reconcilePayouts(
            run.provider,
            capability,
            range,
            found,
          );
        }
      } else {
        await this.checkLedger(found);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Reconciliation run ${run.id} failed: ${message}`);
      await this.runs.update(run.id, {
        status: ReconciliationRunStatus.Failed,
        error: message.slice(0, 1000),
        finishedAt: new Date(),
      });
      return this.getRun(run.id);
    }

    const byIssue: Record<string, number> = {};
    for (const item of found) {
      byIssue[item.issue] = (byIssue[item.issue] ?? 0) + 1;
    }
    summary.byIssue = byIssue;
    summary.autoResolved = found.filter(
      (item) => item.status === ReconciliationItemStatus.AutoResolved,
    ).length;
    summary.issues = found.length - summary.autoResolved;

    await this.dataSource.transaction(async (manager) => {
      if (found.length > 0) {
        await manager.save(
          found.map((item) =>
            manager.create(ReconciliationItem, {
              ...item,
              runId: run.id,
              status: item.status ?? ReconciliationItemStatus.Open,
              resolutionNote: null,
              resolvedByUserId: null,
              resolvedAt:
                item.status === ReconciliationItemStatus.AutoResolved
                  ? new Date()
                  : null,
            }),
          ),
        );
      }
      await manager.update(ReconciliationRun, run.id, {
        status: ReconciliationRunStatus.Completed,
        summary,
        finishedAt: new Date(),
      });
      await this.outbox.add(manager, {
        type: 'reconciliation.completed',
        aggregateType: 'reconciliation_run',
        aggregateId: run.id,
        payload: {
          runId: run.id,
          provider: run.provider,
          periodStart: run.periodStart.toISOString(),
          periodEnd: run.periodEnd.toISOString(),
          openIssues: summary.issues,
          byIssue,
        },
      });
    });
    if ((summary.issues ?? 0) > 0) {
      this.logger.warn(
        `Reconciliation run ${run.id} (${run.provider ?? 'ledger'}) found ${summary.issues} issue(s)`,
      );
    }
    return this.getRun(run.id);
  }

  async getRun(runId: string): Promise<ReconciliationRun> {
    const run = await this.runs.findOneBy({ id: runId });
    if (!run) {
      throw new ReconciliationRunNotFoundException();
    }
    return run;
  }

  listRuns(limit: number): Promise<ReconciliationRun[]> {
    return this.runs.find({ order: { createdAt: 'DESC' }, take: limit });
  }

  /** Newest first, keyset-paginated. */
  async listItems(
    filter: { status?: ReconciliationItemStatus; runId?: string },
    options: { limit: number; before?: Cursor },
  ): Promise<ItemPage> {
    const query = this.items
      .createQueryBuilder('item')
      .orderBy('item.createdAt', 'DESC')
      .addOrderBy('item.id', 'DESC')
      .limit(options.limit + 1);
    if (filter.status) {
      query.andWhere('item.status = :status', { status: filter.status });
    }
    if (filter.runId) {
      query.andWhere('item.runId = :runId', { runId: filter.runId });
    }
    if (options.before) {
      query.andWhere(
        '(item.createdAt, item.id) < (:beforeCreatedAt, :beforeId)',
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

  countOpenItems(): Promise<number> {
    return this.items.countBy({ status: ReconciliationItemStatus.Open });
  }

  /** Marks an open item handled, with what was done. Audited. */
  async resolve(
    itemId: string,
    userId: string,
    note: string,
  ): Promise<ReconciliationItem> {
    await this.dataSource.transaction(async (manager) => {
      const item = await manager
        .createQueryBuilder(ReconciliationItem, 'item')
        .setLock('pessimistic_write')
        .where('item.id = :itemId', { itemId })
        .getOne();
      if (!item) {
        throw new ReconciliationItemNotFoundException();
      }
      if (item.status !== ReconciliationItemStatus.Open) {
        throw new ReconciliationItemNotOpenException();
      }
      await manager.update(ReconciliationItem, item.id, {
        status: ReconciliationItemStatus.Resolved,
        resolutionNote: note,
        resolvedByUserId: userId,
        resolvedAt: new Date(),
      });
      await this.audit.record(manager, {
        action: AuditAction.ReconciliationItemResolved,
        targetType: 'reconciliation_item',
        targetId: item.id,
        metadata: { issue: item.issue, reference: item.reference, note },
      });
    });
    return this.items.findOneByOrFail({ id: itemId });
  }

  // ---- Payments ---------------------------------------------------------------

  private async reconcilePayments(
    provider: string,
    capability: ReconciliationCapability,
    range: TimeRange,
    found: NewItem[],
  ): Promise<number> {
    const theirs = await capability.listPayments(range);
    const ours = await this.payments.listForProvider(provider, range);
    const oursByReference = new Map(
      ours
        .filter((payment) => payment.providerReference)
        .map((payment) => [payment.providerReference as string, payment]),
    );

    const seen = new Set<string>();
    for (const record of theirs) {
      seen.add(record.providerReference);
      // Outside our window (a boundary) still counts: look it up directly.
      const payment =
        oursByReference.get(record.providerReference) ??
        (await this.payments.findByProviderReference(
          provider,
          record.providerReference,
        ));
      if (!payment) {
        if (COLLECTED.has(record.status)) {
          found.push({
            kind: ReconciliationItemKind.Payment,
            issue: ReconciliationIssue.MissingInFinstack,
            reference: record.providerReference,
            targetId: null,
            finstack: null,
            provider: providerPaymentView(record),
          });
        }
        continue;
      }
      await this.comparePayment(payment, record, found);
    }

    // Ours that the provider's list didn't include: ask about each directly.
    for (const payment of ours) {
      if (!payment.providerReference || seen.has(payment.providerReference)) {
        continue;
      }
      const transaction = await this.transactionOf(payment);
      if (!CREDITED.has(transaction.status)) {
        continue; // never credited: nothing at stake
      }
      let record: ProviderPaymentRecord | null = null;
      try {
        const verified = await this.providers.get(provider).verifyPayment({
          reference: transaction.reference,
          providerReference: payment.providerReference,
        });
        record = {
          providerReference: payment.providerReference,
          status: verified.status,
          amount: verified.amount,
          currency: verified.currency,
          createdAt: payment.createdAt,
        };
      } catch (error) {
        if (!(error instanceof PaymentProviderError) || error.retryable) {
          throw error; // the run fails and can be repeated
        }
      }
      if (record) {
        await this.comparePayment(payment, record, found);
      } else {
        found.push({
          kind: ReconciliationItemKind.Payment,
          issue: ReconciliationIssue.CreditedWithoutPayment,
          reference: transaction.reference,
          targetId: payment.id,
          finstack: this.paymentView(payment, transaction),
          provider: null,
        });
      }
    }
    return theirs.length;
  }

  private async comparePayment(
    payment: Payment,
    record: ProviderPaymentRecord,
    found: NewItem[],
  ): Promise<void> {
    let transaction = await this.transactionOf(payment);
    const collected = COLLECTED.has(record.status);
    const item = (
      issue: ReconciliationIssue,
      status?: ReconciliationItemStatus,
    ): NewItem => ({
      kind: ReconciliationItemKind.Payment,
      issue,
      reference: transaction.reference,
      targetId: payment.id,
      finstack: this.paymentView(payment, transaction),
      provider: providerPaymentView(record),
      status,
    });

    if (
      collected &&
      (record.amount !== payment.amount || record.currency !== payment.currency)
    ) {
      found.push(item(ReconciliationIssue.AmountMismatch));
      return;
    }
    if (collected && !CREDITED.has(transaction.status)) {
      if (OPEN_PAYMENT.has(transaction.status)) {
        // A late (or lost) webhook: settle it the normal way.
        await this.settlement.settle(payment).catch(() => undefined);
        transaction = await this.transactionOf(payment);
        if (CREDITED.has(transaction.status)) {
          found.push(
            item(
              ReconciliationIssue.LateSettlement,
              ReconciliationItemStatus.AutoResolved,
            ),
          );
          return;
        }
      }
      found.push(item(ReconciliationIssue.NotCredited));
      return;
    }
    if (!collected && CREDITED.has(transaction.status)) {
      found.push(item(ReconciliationIssue.CreditedWithoutPayment));
    }
  }

  // ---- Payouts ----------------------------------------------------------------

  private async reconcilePayouts(
    provider: string,
    capability: ReconciliationCapability,
    range: TimeRange,
    found: NewItem[],
  ): Promise<number> {
    const theirs = capability.listPayouts
      ? await capability.listPayouts(range)
      : [];
    const ours = await this.payouts.listForProvider(provider, range);
    const oursByReference = new Map(ours.map((p) => [p.reference, p]));

    const seen = new Set<string>();
    for (const record of theirs) {
      seen.add(record.reference);
      const payout =
        oursByReference.get(record.reference) ??
        (await this.payouts.findByReference(provider, record.reference));
      if (!payout) {
        if (record.status !== 'failed') {
          found.push({
            kind: ReconciliationItemKind.Payout,
            issue: ReconciliationIssue.MissingInFinstack,
            reference: record.reference,
            targetId: null,
            finstack: null,
            provider: providerPayoutView(record),
          });
        }
        continue;
      }
      await this.comparePayout(payout, record, found);
    }

    const payouts = this.providers.payoutsOf(provider);
    for (const payout of ours) {
      if (seen.has(payout.reference) || !payout.submittedAt) {
        continue;
      }
      const result = await payouts.find(payout.reference);
      await this.comparePayout(
        payout,
        result
          ? {
              reference: payout.reference,
              providerReference: result.providerReference,
              status: result.status,
              amount: payout.amount,
              currency: payout.currency,
              createdAt: payout.createdAt,
            }
          : null,
        found,
      );
    }
    return theirs.length;
  }

  private async comparePayout(
    payout: Payout,
    record: ProviderPayoutRecord | null,
    found: NewItem[],
  ): Promise<void> {
    const agrees = async (): Promise<Transaction | null> => {
      const transaction = await this.transactionOfPayout(payout);
      const expected = PAYOUT_AGREES[transaction.status];
      return record && expected === record.status ? null : transaction;
    };
    const item = (
      transaction: Transaction,
      issue: ReconciliationIssue,
      status?: ReconciliationItemStatus,
    ): NewItem => ({
      kind: ReconciliationItemKind.Payout,
      issue,
      reference: payout.reference,
      targetId: payout.id,
      finstack: {
        status: transaction.status,
        amount: payout.amount.toString(),
        currency: payout.currency,
      },
      provider: record ? providerPayoutView(record) : null,
      status,
    });

    if (
      record &&
      (record.amount !== payout.amount || record.currency !== payout.currency)
    ) {
      found.push(
        item(
          await this.transactionOfPayout(payout),
          ReconciliationIssue.AmountMismatch,
        ),
      );
      return;
    }
    const mismatch = await agrees();
    if (!mismatch) {
      return;
    }
    if (record) {
      // The provider moved on without telling us: sync the normal way.
      await this.payouts.sync(payout.id).catch(() => undefined);
      const after = await agrees();
      if (!after) {
        found.push(
          item(
            await this.transactionOfPayout(payout),
            ReconciliationIssue.LateSettlement,
            ReconciliationItemStatus.AutoResolved,
          ),
        );
        return;
      }
      found.push(item(after, ReconciliationIssue.StatusMismatch));
      return;
    }
    // The provider has no record of a payout we sent.
    if (mismatch.status === TransactionStatus.Failed) {
      return; // failed and never arrived: consistent
    }
    if (mismatch.status === TransactionStatus.Processing) {
      // Never arrived: sync resends it once that is safe.
      await this.payouts.sync(payout.id).catch(() => undefined);
      const result = await this.providers
        .payoutsOf(payout.provider)
        .find(payout.reference);
      if (result) {
        await this.comparePayout(
          payout,
          {
            reference: payout.reference,
            providerReference: result.providerReference,
            status: result.status,
            amount: payout.amount,
            currency: payout.currency,
            createdAt: payout.createdAt,
          },
          found,
        );
        return;
      }
    }
    found.push(item(mismatch, ReconciliationIssue.StatusMismatch));
  }

  // ---- Ledger -----------------------------------------------------------------

  private async checkLedger(found: NewItem[]): Promise<void> {
    for (const discrepancy of await this.ledger.findBalanceDiscrepancies()) {
      found.push({
        kind: ReconciliationItemKind.Ledger,
        issue: ReconciliationIssue.BalanceDiscrepancy,
        reference: discrepancy.accountId,
        targetId: discrepancy.accountId,
        finstack: {
          cached: discrepancy.cachedBalance.toString(),
          computed: discrepancy.computedBalance.toString(),
        },
        provider: null,
      });
    }
    for (const currency of await this.ledger.currencies()) {
      const trial = await this.ledger.trialBalance(currency);
      if (trial.debit !== trial.credit) {
        found.push({
          kind: ReconciliationItemKind.Ledger,
          issue: ReconciliationIssue.TrialBalanceMismatch,
          reference: currency,
          targetId: null,
          finstack: {
            currency,
            debit: trial.debit.toString(),
            credit: trial.credit.toString(),
          },
          provider: null,
        });
      }
    }
  }

  // ---- Helpers ----------------------------------------------------------------

  private transactionOf(payment: Payment): Promise<Transaction> {
    return this.transactions.getById(payment.transactionId);
  }

  private transactionOfPayout(payout: Payout): Promise<Transaction> {
    return this.transactions.getById(payout.transactionId);
  }

  private paymentView(
    payment: Payment,
    transaction: Transaction,
  ): Record<string, unknown> {
    return {
      paymentId: payment.id,
      reference: transaction.reference,
      status: transaction.status,
      amount: payment.amount.toString(),
      currency: payment.currency,
    };
  }
}

function providerPaymentView(
  record: ProviderPaymentRecord,
): Record<string, unknown> {
  return {
    providerReference: record.providerReference,
    reference: record.reference ?? null,
    status: record.status,
    amount: record.amount.toString(),
    currency: record.currency,
    createdAt: record.createdAt.toISOString(),
  };
}

function providerPayoutView(
  record: ProviderPayoutRecord,
): Record<string, unknown> {
  return {
    reference: record.reference,
    providerReference: record.providerReference,
    status: record.status,
    amount: record.amount.toString(),
    currency: record.currency,
    createdAt: record.createdAt.toISOString(),
  };
}
