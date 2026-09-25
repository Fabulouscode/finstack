import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AdminAuditLogsController } from './admin-audit-logs.controller';
import { OrganizationAuditLogsController } from './organization-audit-logs.controller';

@Module({
  imports: [OrganizationsModule],
  controllers: [AdminAuditLogsController, OrganizationAuditLogsController],
})
export class AuditApiModule {}
