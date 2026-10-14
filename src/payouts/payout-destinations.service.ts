import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import type { CurrencyCode } from '../common/money/currency';
import { OwnerRef, ownerColumns, ownerWhere } from '../common/owner/owner';
import { payoutsConfig } from '../config/payouts.config';
import type { PayoutsConfig } from '../config/payouts.config';
import { OutboxService } from '../outbox/outbox.service';
import { isUniqueViolation } from '../database/postgres-errors';
import { PaymentProviderError } from '../payment-providers/payment-provider';
import { PaymentProvidersService } from '../payment-providers/payment-providers.service';
import { PaymentProviderUnavailableException } from '../payments/payments.errors';
import {
  PayoutDestination,
  describeDestination,
} from './payout-destination.entity';
import type { PayoutDestinationKind } from './payout-destination.entity';
import {
  PayoutDestinationAlreadyExistsException,
  PayoutDestinationNotFoundException,
  PayoutDestinationRejectedException,
} from './payouts.errors';

export interface NewPayoutDestination {
  currency: CurrencyCode;
  kind?: PayoutDestinationKind;
  /** Bank destinations. */
  bankCode?: string;
  accountNumber?: string;
  /** PayPal destinations. */
  email?: string;
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
    private readonly outbox: OutboxService,
    @Inject(payoutsConfig.KEY) private readonly config: PayoutsConfig,
  ) {}

  /**
   * Saves a bank account with the provider (which verifies it) and keeps
   * only the provider's reference and the last four digits; or a PayPal
   * account by its email, with a provider that pays to email.
   */
  async add(
    owner: OwnerRef,
    input: NewPayoutDestination,
  ): Promise<PayoutDestination> {
    const { name, payouts } = this.providers.selectForPayout(
      input.currency,
      input.provider,
    );

    const kind = input.kind ?? 'bank';
    let recipient;
    try {
      if (kind === 'paypal') {
        if (!payouts.createEmailRecipient || !input.email) {
          throw new PayoutDestinationRejectedException(
            `${name} can't pay out to a PayPal email`,
          );
        }
        recipient = await payouts.createEmailRecipient({
          currency: input.currency,
          email: input.email,
          name: input.accountName,
        });
      } else {
        recipient = await payouts.createRecipient({
          currency: input.currency,
          bankCode: input.bankCode ?? '',
          accountNumber: input.accountNumber ?? '',
          accountName: input.accountName,
        });
      }
    } catch (error) {
      if (error instanceof PayoutDestinationRejectedException) throw error;
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
            kind,
            bankCode: kind === 'bank' ? (input.bankCode ?? null) : null,
            bankName: recipient.bankName,
            accountName: recipient.accountName,
            accountNumberLast4:
              kind === 'bank' ? (input.accountNumber ?? '').slice(-4) : null,
            email: kind === 'paypal' ? recipient.recipientReference : null,
            label: input.label ?? null,
            removedAt: null,
            payoutsAvailableAt: new Date(
              Date.now() + this.config.destinationCooldownMinutes * 60_000,
            ),
          }),
        );
        // Tells the owner (email), so an account they didn't add is noticed.
        await this.outbox.add(manager, {
          type: 'payout_destination.added',
          aggregateType: 'payout_destination',
          aggregateId: destination.id,
          payload: {
            destinationId: destination.id,
            userId: destination.userId,
            organizationId: destination.organizationId,
            accountName: destination.accountName,
            bankName: destination.bankName,
            accountNumberLast4: destination.accountNumberLast4,
            description: describeDestination(destination),
            currency: destination.currency,
            payoutsAvailableAt: destination.payoutsAvailableAt.toISOString(),
          },
        });
        await this.audit.record(manager, {
          action: AuditAction.PayoutDestinationAdded,
          organizationId: destination.organizationId,
          targetType: 'payout_destination',
          targetId: destination.id,
          metadata: {
            provider: name,
            currency: input.currency,
            kind,
            bankCode: destination.bankCode,
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
