import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FxModule } from '../fx/fx.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentProvidersModule } from '../payment-providers/payment-providers.module';
import { Transaction } from '../transactions/transaction.entity';
import { TransactionsModule } from '../transactions/transactions.module';
import { UsersModule } from '../users/users.module';
import { WalletsModule } from '../wallets/wallets.module';
import { AdminPaymentsController } from './admin-payments.controller';
import { Payment } from './payment.entity';
import { SettlementReleaseService } from './settlement-release.service';
import { PaymentSettlementService } from './payment-settlement.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

import { OrganizationPaymentsController } from './organization-payments.controller';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [
    OrganizationsModule,
    TypeOrmModule.forFeature([Payment, Transaction]),
    IdempotencyModule,
    OutboxModule,
    PaymentProvidersModule,
    TransactionsModule,
    WalletsModule,
    FxModule,
    UsersModule,
  ],
  controllers: [
    AdminPaymentsController,
    PaymentsController,
    OrganizationPaymentsController,
  ],
  providers: [
    PaymentsService,
    PaymentSettlementService,
    SettlementReleaseService,
  ],
  exports: [
    PaymentsService,
    PaymentSettlementService,
    SettlementReleaseService,
  ],
})
export class PaymentsModule {}
