import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentProvidersModule } from '../payment-providers/payment-providers.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { WalletsModule } from '../wallets/wallets.module';
import { AdminRefundsController } from './admin-refunds.controller';
import { Refund } from './refund.entity';
import { RefundsService } from './refunds.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Refund]),
    IdempotencyModule,
    LedgerModule,
    OutboxModule,
    PaymentProvidersModule,
    TransactionsModule,
    WalletsModule,
  ],
  controllers: [AdminRefundsController],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
