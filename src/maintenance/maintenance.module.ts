import { Module } from '@nestjs/common';
import { QueuesModule } from '../queues/queues.module';
import { MaintenanceProcessor } from './maintenance.processor';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [QueuesModule],
  providers: [MaintenanceService, MaintenanceProcessor],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
