import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { OutboxModule } from '../outbox/outbox.module';
import { UsersModule } from '../users/users.module';
import { WalletsModule } from '../wallets/wallets.module';
import { Transaction } from './transaction.entity';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { TransfersService } from './transfers.service';

import { OrganizationTransactionsController } from './organization-transactions.controller';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [
    OrganizationsModule,
    TypeOrmModule.forFeature([Transaction]),
    IdempotencyModule,
    OutboxModule,
    UsersModule,
    WalletsModule,
  ],
  controllers: [TransactionsController, OrganizationTransactionsController],
  providers: [TransactionsService, TransfersService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
