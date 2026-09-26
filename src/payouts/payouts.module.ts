import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FeesModule } from '../fees/fees.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentProvidersModule } from '../payment-providers/payment-providers.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { WalletsModule } from '../wallets/wallets.module';
import { AdminPayoutsController } from './admin-payouts.controller';
import { OrganizationPayoutsController } from './organization-payouts.controller';
import { PayoutDestination } from './payout-destination.entity';
import { PayoutDestinationsService } from './payout-destinations.service';
import { Payout } from './payout.entity';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payout, PayoutDestination]),
    FeesModule,
    IdempotencyModule,
    LedgerModule,
    OrganizationsModule,
    OutboxModule,
    PaymentProvidersModule,
    TransactionsModule,
    WalletsModule,
  ],
  controllers: [
    PayoutsController,
    OrganizationPayoutsController,
    AdminPayoutsController,
  ],
  providers: [PayoutsService, PayoutDestinationsService],
  exports: [PayoutsService],
})
export class PayoutsModule {}
