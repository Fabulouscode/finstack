import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AuditAction, AuditActionName } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { RefreshTokenService } from '../auth/tokens/refresh-token.service';
import { LedgerService } from '../ledger/ledger.service';
import {
  Organization,
  OrganizationStatus,
} from '../organizations/organization.entity';
import { OrganizationsService } from '../organizations/organizations.service';
import { OutboundWebhooksService } from '../outbound-webhooks/outbound-webhooks.service';
import { PayoutsService } from '../payouts/payouts.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { RefundsService } from '../refunds/refunds.service';
import { User, UserStatus } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { WalletStatus } from '../wallets/wallet.entity';
import { WalletsService, WalletWithBalances } from '../wallets/wallets.service';
import { WebhookEventStatus } from '../webhooks/webhook-event.entity';
import { WebhooksService } from '../webhooks/webhooks.service';
import {
  CannotSuspendSelfException,
  InvalidStatusChangeException,
  UserNotFoundException,
} from './admin.errors';

export interface AdminOverview {
  users: Record<string, number>;
  organizations: Record<string, number>;
  /** What FinStack owes wallet holders, per currency (minor units). */
  walletBalances: Record<
    string,
    { available: bigint; pending: bigint; reserved: bigint }
  >;
  /** Earned by the platform, per currency (minor units). */
  revenue: { fees: Record<string, bigint>; fx: Record<string, bigint> };
  attention: {
    processingPayouts: { count: number; oldest: Date | null };
    processingRefunds: { count: number; oldest: Date | null };
    openReconciliationItems: number;
    failedInboundWebhooks: number;
    failedOutboundDeliveriesLast24h: number;
    disabledWebhookEndpoints: number;
  };
}

/**
 * Platform operator actions. Each changes state through the owning module's
 * service and is audited with the reason, in the same database transaction.
 */
@Injectable()
export class AdminService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly users: UsersService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly organizations: OrganizationsService,
    private readonly wallets: WalletsService,
    private readonly payouts: PayoutsService,
    private readonly refunds: RefundsService,
    private readonly reconciliation: ReconciliationService,
    private readonly inboundWebhooks: WebhooksService,
    private readonly outboundWebhooks: OutboundWebhooksService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  async getUser(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UserNotFoundException();
    }
    return user;
  }

  /**
   * Blocks the account at once: every request is refused (the auth guard
   * checks the account) and all sessions are revoked.
   */
  async setUserStatus(
    adminId: string,
    userId: string,
    status: UserStatus,
    reason: string,
  ): Promise<User> {
    if (status === UserStatus.Suspended && userId === adminId) {
      throw new CannotSuspendSelfException();
    }
    const user = await this.getUser(userId);
    if (user.status === status) {
      throw new InvalidStatusChangeException(`The user is already ${status}`);
    }
    await this.changeWithAudit(
      status === UserStatus.Suspended
        ? AuditAction.UserSuspended
        : AuditAction.UserReactivated,
      'user',
      userId,
      null,
      reason,
      (manager) => this.users.setStatus(userId, status, manager),
    );
    if (status === UserStatus.Suspended) {
      await this.refreshTokens.revokeAllForUser(userId);
    }
    return this.getUser(userId);
  }

  async setOrganizationStatus(
    organizationId: string,
    status: OrganizationStatus,
    reason: string,
  ): Promise<Organization> {
    const organization = await this.organizations.get(organizationId);
    if (organization.status === status) {
      throw new InvalidStatusChangeException(
        `The organization is already ${status}`,
      );
    }
    await this.changeWithAudit(
      status === OrganizationStatus.Suspended
        ? AuditAction.OrganizationSuspended
        : AuditAction.OrganizationReactivated,
      'organization',
      organizationId,
      organizationId,
      reason,
      (manager) =>
        this.organizations.setStatus(organizationId, status, manager),
    );
    return this.organizations.get(organizationId);
  }

  /** Freezing stops money leaving the wallet; closed wallets can't be changed. */
  async setWalletStatus(
    walletId: string,
    status: WalletStatus.Active | WalletStatus.Frozen,
    reason: string,
  ): Promise<WalletWithBalances> {
    const { wallet } = await this.wallets.getWithBalances(walletId);
    if (wallet.status === WalletStatus.Closed) {
      throw new InvalidStatusChangeException('Closed wallets cannot change');
    }
    if (wallet.status === status) {
      throw new InvalidStatusChangeException(`The wallet is already ${status}`);
    }
    await this.changeWithAudit(
      status === WalletStatus.Frozen
        ? AuditAction.WalletFrozen
        : AuditAction.WalletUnfrozen,
      'wallet',
      walletId,
      wallet.organizationId,
      reason,
      (manager) => this.wallets.setStatus(walletId, status, manager),
    );
    return this.wallets.getWithBalances(walletId);
  }

  async overview(): Promise<AdminOverview> {
    const [
      users,
      organizations,
      walletBalances,
      processingPayouts,
      processingRefunds,
      openReconciliationItems,
      failedInboundWebhooks,
      outbound,
      feeRevenue,
      fxRevenue,
    ] = await Promise.all([
      this.users.countByStatus(),
      this.organizations.countByStatus(),
      this.wallets.balanceTotals(),
      this.payouts.processingStats(),
      this.refunds.processingStats(),
      this.reconciliation.countOpenItems(),
      this.inboundWebhooks.countByStatus(WebhookEventStatus.Failed),
      this.outboundWebhooks.stats(),
      this.ledger.systemBalances('system:fee-revenue:'),
      this.ledger.systemBalances('system:fx-revenue:'),
    ]);
    return {
      users,
      organizations,
      walletBalances,
      revenue: { fees: feeRevenue, fx: fxRevenue },
      attention: {
        processingPayouts,
        processingRefunds,
        openReconciliationItems,
        failedInboundWebhooks,
        failedOutboundDeliveriesLast24h: outbound.failedDeliveriesLast24h,
        disabledWebhookEndpoints: outbound.disabledEndpoints,
      },
    };
  }

  private async changeWithAudit(
    action: AuditActionName,
    targetType: string,
    targetId: string,
    organizationId: string | null,
    reason: string,
    change: (manager: EntityManager) => Promise<void>,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await change(manager);
      await this.audit.record(manager, {
        action,
        targetType,
        targetId,
        organizationId,
        metadata: { reason },
      });
    });
  }
}
