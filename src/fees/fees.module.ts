import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AdminFeesController } from './admin-fees.controller';
import { FeeRule } from './fee-rule.entity';
import {
  FeeQuotesController,
  OrganizationFeeQuotesController,
} from './fee-quotes.controller';
import { FeesService } from './fees.service';

/** Fee rules and quotes. Money flows ask it what to charge. */
@Module({
  imports: [TypeOrmModule.forFeature([FeeRule]), OrganizationsModule],
  controllers: [
    AdminFeesController,
    FeeQuotesController,
    OrganizationFeeQuotesController,
  ],
  providers: [FeesService],
  exports: [FeesService],
})
export class FeesModule {}
