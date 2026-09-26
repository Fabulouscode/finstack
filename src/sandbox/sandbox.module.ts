import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PaymentProvidersModule } from '../payment-providers/payment-providers.module';
import { PaymentsModule } from '../payments/payments.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { WalletsModule } from '../wallets/wallets.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import {
  OrganizationSandboxController,
  SandboxController,
} from './sandbox.controller';
import { SandboxService } from './sandbox.service';

/** Simulation API for integrators (development and sandbox deployments). */
@Module({
  imports: [
    OrganizationsModule,
    PaymentProvidersModule,
    PaymentsModule,
    PayoutsModule,
    WalletsModule,
    WebhooksModule,
  ],
  controllers: [SandboxController, OrganizationSandboxController],
  providers: [SandboxService],
})
export class SandboxModule {}
