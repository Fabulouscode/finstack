import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationsModule } from '../organizations/organizations.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { LimitRule } from './limit-rule.entity';
import {
  AdminLimitsController,
  LimitsController,
  OrganizationLimitsController,
} from './limits.controller';
import { LimitsService } from './limits.service';

/** Velocity limits on payments, payouts and transfers. */
@Module({
  imports: [
    TypeOrmModule.forFeature([LimitRule]),
    OrganizationsModule,
    forwardRef(() => TransactionsModule),
  ],
  controllers: [
    LimitsController,
    OrganizationLimitsController,
    AdminLimitsController,
  ],
  providers: [LimitsService],
  exports: [LimitsService],
})
export class LimitsModule {}
