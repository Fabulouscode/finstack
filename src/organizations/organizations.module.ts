import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { OrganizationAccessGuard } from './guards/organization-access.guard';
import { Membership } from './membership.entity';
import { Organization } from './organization.entity';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  imports: [TypeOrmModule.forFeature([Organization, Membership]), UsersModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService, OrganizationAccessGuard],
  exports: [OrganizationsService, OrganizationAccessGuard],
})
export class OrganizationsModule {}
