import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentProvidersModule } from '../payment-providers/payment-providers.module';
import { PaymentsModule } from '../payments/payments.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { QueuesModule } from '../queues/queues.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { AdminReconciliationController } from './admin-reconciliation.controller';
import { ReconciliationItem } from './reconciliation-item.entity';
import { ReconciliationRun } from './reconciliation-run.entity';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ReconciliationRun, ReconciliationItem]),
    LedgerModule,
    OutboxModule,
    PaymentProvidersModule,
    PaymentsModule,
    PayoutsModule,
    QueuesModule,
    TransactionsModule,
  ],
  controllers: [AdminReconciliationController],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
