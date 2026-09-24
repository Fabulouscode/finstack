import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerAccount } from './ledger-account.entity';
import { LedgerEntry } from './ledger-entry.entity';
import { LedgerTransaction } from './ledger-transaction.entity';
import { LedgerService } from './ledger.service';

/** Internal double-entry ledger. No HTTP surface; other modules post through LedgerService. */
@Module({
  imports: [
    TypeOrmModule.forFeature([LedgerAccount, LedgerTransaction, LedgerEntry]),
  ],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
