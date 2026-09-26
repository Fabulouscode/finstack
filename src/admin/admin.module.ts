import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OutboundWebhooksModule } from '../outbound-webhooks/outbound-webhooks.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { RefundsModule } from '../refunds/refunds.module';
import { UsersModule } from '../users/users.module';
import { WalletsModule } from '../wallets/wallets.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AdminOrganizationsController } from './admin-organizations.controller';
import { AdminOverviewController } from './admin-overview.controller';
import { AdminUsersController } from './admin-users.controller';
import { AdminWalletsController } from './admin-wallets.controller';
import { AdminService } from './admin.service';

/**
 * Operator tooling. A leaf module: it only uses other modules' services,
 * so every action follows the same rules as the rest of the API.
 */
@Module({
  imports: [
    AuthModule,
    LedgerModule,
    OrganizationsModule,
    OutboundWebhooksModule,
    PayoutsModule,
    ReconciliationModule,
    RefundsModule,
    UsersModule,
    WalletsModule,
    WebhooksModule,
  ],
  controllers: [
    AdminOverviewController,
    AdminUsersController,
    AdminOrganizationsController,
    AdminWalletsController,
  ],
  providers: [AdminService],
})
export class AdminModule {}
