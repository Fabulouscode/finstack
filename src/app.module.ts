import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { HttpModule } from './common/http/http.module';
import { FxModule } from './fx/fx.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { LedgerModule } from './ledger/ledger.module';
import { UsersModule } from './users/users.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    HttpModule,
    HealthModule,
    UsersModule,
    AuthModule,
    LedgerModule,
    WalletsModule,
    FxModule,
  ],
})
export class AppModule {}
