import { AdminModule } from './admin/admin.module';
import { AuditApiModule } from './audit/audit-api.module';
import { AuditModule } from './audit/audit.module';
import { ObservabilityModule } from './observability/observability.module';
import { FeesModule } from './fees/fees.module';
import { PayoutsModule } from './payouts/payouts.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { HttpModule } from './common/http/http.module';
import { EventsModule } from './events/events.module';
import { FxModule } from './fx/fx.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { LedgerModule } from './ledger/ledger.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { PaymentsModule } from './payments/payments.module';
import { RefundsModule } from './refunds/refunds.module';
import { TransactionsModule } from './transactions/transactions.module';
import { UsersModule } from './users/users.module';
import { WalletsModule } from './wallets/wallets.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuditModule,
    ObservabilityModule,
    AuditApiModule,
    HttpModule,
    HealthModule,
    IdempotencyModule,
    UsersModule,
    AuthModule,
    OrganizationsModule,
    LedgerModule,
    WalletsModule,
    FxModule,
    TransactionsModule,
    FeesModule,
    PaymentsModule,
    RefundsModule,
    PayoutsModule,
    ReconciliationModule,
    AdminModule,
    WebhooksModule,
    EventsModule,
    MaintenanceModule,
  ],
})
export class AppModule {}
