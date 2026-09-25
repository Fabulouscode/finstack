import { Module } from '@nestjs/common';
import { PayoutsModule } from '../payouts/payouts.module';
import { QueuesModule } from '../queues/queues.module';
import { MaintenanceProcessor } from './maintenance.processor';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [QueuesModule, PayoutsModule],
  providers: [MaintenanceService, MaintenanceProcessor],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
