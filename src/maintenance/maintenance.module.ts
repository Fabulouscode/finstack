import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { QueuesModule } from '../queues/queues.module';
import { MaintenanceProcessor } from './maintenance.processor';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [QueuesModule, PayoutsModule, PaymentsModule, ReconciliationModule],
  providers: [MaintenanceService, MaintenanceProcessor],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
