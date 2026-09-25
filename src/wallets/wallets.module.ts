import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FxModule } from '../fx/fx.module';
import { LedgerModule } from '../ledger/ledger.module';
import { Wallet } from './wallet.entity';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

import { OrganizationWalletsController } from './organization-wallets.controller';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [
    OrganizationsModule,
    TypeOrmModule.forFeature([Wallet]),
    LedgerModule,
    FxModule,
  ],
  controllers: [WalletsController, OrganizationWalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
