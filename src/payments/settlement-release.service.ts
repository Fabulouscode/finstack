import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { WalletsService } from '../wallets/wallets.service';
import { Payment } from './payment.entity';
import { PaymentNotFoundException } from './payments.errors';

/**
 * Ends settlement holds (PAYMENT_SETTLEMENT_DELAY_SECONDS): moves a
 * payment's remaining pending credit to the wallet's available balance.
 */
@Injectable()
export class SettlementReleaseService {
  private readonly logger = new Logger(SettlementReleaseService.name);

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly wallets: WalletsService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  /** Releases every payment whose hold has ended (run by the maintenance worker). */
  async releaseDue(limit = 100): Promise<number> {
    const due = await this.payments.find({
      select: { id: true },
      where: {
        pendingAmount: MoreThan(0n),
        fundsAvailableAt: LessThanOrEqual(new Date()),
      },
      order: { fundsAvailableAt: 'ASC' },
      take: limit,
    });
    let released = 0;
    for (const { id } of due) {
      if (await this.release(id)) released++;
    }
    return released;
  }

  /** Admin: ends a payment's hold now (e.g. a trusted merchant). Audited. */
  async releaseEarly(paymentId: string): Promise<Payment> {
    await this.release(paymentId, true);
    const payment = await this.payments.findOneBy({ id: paymentId });
    if (!payment) {
      throw new PaymentNotFoundException();
    }
    return payment;
  }

  /**
   * Idempotent: the payment row lock serialises this with refunds (which
   * may take from the pending part) and concurrent releases.
   */
  private async release(paymentId: string, early = false): Promise<boolean> {
    const released = await this.dataSource.transaction(async (manager) => {
      const payment = await manager
        .createQueryBuilder(Payment, 'payment')
        .setLock('pessimistic_write')
        .where('payment.id = :paymentId', { paymentId })
        .getOne();
      if (!payment) {
        throw new PaymentNotFoundException();
      }
      if (payment.pendingAmount === 0n) {
        return false;
      }

      const amount = payment.pendingAmount;
      await this.wallets.makeAvailableWithin(manager, payment.walletId, {
        amount,
        reference: `settlement:${payment.id}`,
        description: `Settlement of payment ${payment.id}`,
        metadata: { paymentId: payment.id },
      });
      const now = new Date();
      await manager.update(Payment, payment.id, {
        pendingAmount: 0n,
        fundsAvailableAt:
          payment.fundsAvailableAt && payment.fundsAvailableAt < now
            ? payment.fundsAvailableAt
            : now,
      });
      await this.outbox.add(manager, {
        type: 'payment.funds_available',
        aggregateType: 'transaction',
        aggregateId: payment.transactionId,
        payload: {
          paymentId: payment.id,
          walletId: payment.walletId,
          userId: payment.userId,
          organizationId: payment.organizationId,
          amount: amount.toString(),
          early,
        },
      });
      if (early) {
        await this.audit.record(manager, {
          action: AuditAction.PaymentReleasedEarly,
          organizationId: payment.organizationId,
          targetType: 'payment',
          targetId: payment.id,
          metadata: {
            amount: amount.toString(),
            scheduledFor: payment.fundsAvailableAt,
          },
        });
      }
      return true;
    });
    if (released && early) {
      this.logger.log(`Payment ${paymentId} released early`);
    }
    return released;
  }
}
