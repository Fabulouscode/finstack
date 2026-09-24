import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerModule } from '../ledger/ledger.module';
import { AdminRateProvider } from './admin-rate.provider';
import { FxQuote } from './fx-quote.entity';
import { FxRate } from './fx-rate.entity';
import { FxController } from './fx.controller';
import { FxService } from './fx.service';
import { FX_RATE_PROVIDER } from './rate-provider';

@Module({
  imports: [TypeOrmModule.forFeature([FxRate, FxQuote]), LedgerModule],
  controllers: [FxController],
  providers: [
    FxService,
    AdminRateProvider,
    // Swap for an external feed by binding another RateProvider here.
    { provide: FX_RATE_PROVIDER, useExisting: AdminRateProvider },
  ],
  exports: [FxService],
})
export class FxModule {}
