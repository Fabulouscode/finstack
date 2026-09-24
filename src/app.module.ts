import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { HttpModule } from './common/http/http.module';
import { FxModule } from './fx/fx.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { LedgerModule } from './ledger/ledger.module';
import { PaymentsModule } from './payments/payments.module';
import { TransactionsModule } from './transactions/transactions.module';
import { UsersModule } from './users/users.module';
import { WalletsModule } from './wallets/wallets.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    HttpModule,
    HealthModule,
    IdempotencyModule,
    UsersModule,
    AuthModule,
    LedgerModule,
    WalletsModule,
    FxModule,
    TransactionsModule,
    PaymentsModule,
    WebhooksModule,
  ],
})
export class AppModule {}
