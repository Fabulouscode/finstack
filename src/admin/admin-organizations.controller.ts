import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor';
import { organizationOwner } from '../common/owner/owner';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { MemberResponseDto } from '../organizations/dto/organization.dto';
import {
  Organization,
  OrganizationStatus,
} from '../organizations/organization.entity';
import { OrganizationsService } from '../organizations/organizations.service';
import { UserRole } from '../users/user.entity';
import { WalletResponseDto } from '../wallets/dto/wallet.dto';
import { WalletsService } from '../wallets/wallets.service';
import { AdminService } from './admin.service';
import {
  AdminReasonRequestDto,
  SearchOrganizationsQueryDto,
} from './dto/admin.dto';

class AdminOrganizationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Acme Payments Ltd' })
  name: string;

  @ApiProperty({ enum: OrganizationStatus })
  status: OrganizationStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  static from(organization: Organization): AdminOrganizationDto {
    return {
      id: organization.id,
      name: organization.name,
      status: organization.status,
      createdAt: organization.createdAt,
    };
  }
}

class AdminOrganizationsPageDto {
  @ApiProperty({ type: [AdminOrganizationDto] })
  data: AdminOrganizationDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

class AdminOrganizationDetailDto {
  @ApiProperty({ type: AdminOrganizationDto })
  organization: AdminOrganizationDto;

  @ApiProperty({ type: [MemberResponseDto] })
  members: MemberResponseDto[];

  @ApiProperty({ type: [WalletResponseDto] })
  wallets: WalletResponseDto[];
}

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@Roles(UserRole.Admin)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'FORBIDDEN: admin role required')
@Controller('admin/organizations')
export class AdminOrganizationsController {
  constructor(
    private readonly admin: AdminService,
    private readonly organizations: OrganizationsService,
    private readonly wallets: WalletsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Search organizations',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: AdminOrganizationsPageDto })
  @ApiValidationProblemResponse()
  async search(
    @Query() query: SearchOrganizationsQueryDto,
  ): Promise<AdminOrganizationsPageDto> {
    const page = await this.organizations.search(
      { name: query.name, status: query.status },
      {
        limit: query.limit,
        before: query.cursor ? decodeCursor(query.cursor) : undefined,
      },
    );
    return {
      data: page.organizations.map((org) => AdminOrganizationDto.from(org)),
      nextCursor: page.next ? encodeCursor(page.next) : null,
    };
  }

  @Get(':organizationId')
  @ApiOperation({ summary: 'An organization with its members and wallets' })
  @ApiOkResponse({ type: AdminOrganizationDetailDto })
  @ApiProblemResponse(404, 'ORGANIZATION_NOT_FOUND')
  async get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<AdminOrganizationDetailDto> {
    const organization = await this.organizations.get(organizationId);
    const [members, wallets] = await Promise.all([
      this.organizations.listMembers(organizationId),
      this.wallets.listFor(organizationOwner(organizationId)),
    ]);
    return {
      organization: AdminOrganizationDto.from(organization),
      members: members.map((member) => MemberResponseDto.from(member)),
      wallets: wallets.map((wallet) => WalletResponseDto.from(wallet)),
    };
  }

  @Post(':organizationId/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspend an organization',
    description:
      'Members can still read, but nothing can be changed and its API keys stop working. Audited with the reason.',
  })
  @ApiOkResponse({ type: AdminOrganizationDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(404, 'ORGANIZATION_NOT_FOUND')
  @ApiProblemResponse(409, 'INVALID_STATUS_CHANGE')
  async suspend(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: AdminReasonRequestDto,
  ): Promise<AdminOrganizationDto> {
    return AdminOrganizationDto.from(
      await this.admin.setOrganizationStatus(
        organizationId,
        OrganizationStatus.Suspended,
        body.reason,
      ),
    );
  }

  @Post(':organizationId/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a suspended organization' })
  @ApiOkResponse({ type: AdminOrganizationDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(404, 'ORGANIZATION_NOT_FOUND')
  @ApiProblemResponse(409, 'INVALID_STATUS_CHANGE')
  async reactivate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: AdminReasonRequestDto,
  ): Promise<AdminOrganizationDto> {
    return AdminOrganizationDto.from(
      await this.admin.setOrganizationStatus(
        organizationId,
        OrganizationStatus.Active,
        body.reason,
      ),
    );
  }
}
