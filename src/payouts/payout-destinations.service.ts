import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import type { CurrencyCode } from '../common/money/currency';
import { OwnerRef, ownerColumns, ownerWhere } from '../common/owner/owner';
import { isUniqueViolation } from '../database/postgres-errors';
import { PaymentProviderError } from '../payment-providers/payment-provider';
import { PaymentProvidersService } from '../payment-providers/payment-providers.service';
import { PaymentProviderUnavailableException } from '../payments/payments.errors';
import { PayoutDestination } from './payout-destination.entity';
import {
  PayoutDestinationAlreadyExistsException,
  PayoutDestinationNotFoundException,
  PayoutDestinationRejectedException,
} from './payouts.errors';

export interface NewPayoutDestination {
  currency: CurrencyCode;
  bankCode: string;
  accountNumber: string;
  accountName?: string;
  provider?: string;
  label?: string;
}

@Injectable()
export class PayoutDestinationsService {
  constructor(
    @InjectRepository(PayoutDestination)
    private readonly destinations: Repository<PayoutDestination>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly providers: PaymentProvidersService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Saves a bank account with the provider (which verifies it) and keeps
   * only the provider's reference and the last four digits.
   */
  async add(
    owner: OwnerRef,
    input: NewPayoutDestination,
  ): Promise<PayoutDestination> {
    const { name, payouts } = this.providers.selectForPayout(
      input.currency,
      input.provider,
    );

    let recipient;
    try {
      recipient = await payouts.createRecipient({
        currency: input.currency,
        bankCode: input.bankCode,
        accountNumber: input.accountNumber,
        accountName: input.accountName,
      });
    } catch (error) {
      if (error instanceof PaymentProviderError && !error.retryable) {
        throw new PayoutDestinationRejectedException(error.message);
      }
      throw new PaymentProviderUnavailableException();
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        const destination = await manager.save(
          manager.create(PayoutDestination, {
            ...ownerColumns(owner),
            provider: name,
            currency: input.currency,
            recipientReference: recipient.recipientReference,
            bankCode: input.bankCode,
            bankName: recipient.bankName,
            accountName: recipient.accountName,
            accountNumberLast4: input.accountNumber.slice(-4),
            label: input.label ?? null,
            removedAt: null,
          }),
        );
        await this.audit.record(manager, {
          action: AuditAction.PayoutDestinationAdded,
          organizationId: destination.organizationId,
          targetType: 'payout_destination',
          targetId: destination.id,
          metadata: {
            provider: name,
            currency: input.currency,
            bankCode: input.bankCode,
            accountName: destination.accountName,
            accountNumberLast4: destination.accountNumberLast4,
          },
        });
        return destination;
      });
    } catch (error) {
      if (
        isUniqueViolation(error, [
          'uq_payout_destinations_user_recipient',
          'uq_payout_destinations_org_recipient',
        ])
      ) {
        throw new PayoutDestinationAlreadyExistsException();
      }
      throw error;
    }
  }

  list(owner: OwnerRef): Promise<PayoutDestination[]> {
    return this.destinations.find({
      where: { ...ownerWhere(owner), removedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  /** An active destination of this owner. */
  async getActive(
    owner: OwnerRef,
    destinationId: string,
  ): Promise<PayoutDestination> {
    const destination = await this.destinations.findOneBy({
      id: destinationId,
      ...ownerWhere(owner),
      removedAt: IsNull(),
    });
    if (!destination) {
      throw new PayoutDestinationNotFoundException();
    }
    return destination;
  }

  async remove(owner: OwnerRef, destinationId: string): Promise<void> {
    const destination = await this.getActive(owner, destinationId);
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        PayoutDestination,
        { id: destination.id, removedAt: IsNull() },
        { removedAt: new Date() },
      );
      await this.audit.record(manager, {
        action: AuditAction.PayoutDestinationRemoved,
        organizationId: destination.organizationId,
        targetType: 'payout_destination',
        targetId: destination.id,
      });
    });
  }
}
