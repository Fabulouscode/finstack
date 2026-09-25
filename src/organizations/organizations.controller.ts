import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { AllowApiKey } from '../api-keys/api-key-principal';
import { ACCESS_TOKEN_SCHEME, API_KEY_SCHEME } from '../docs/swagger';
import {
  AddMemberRequestDto,
  ChangeRoleRequestDto,
  CreateOrganizationRequestDto,
  MemberResponseDto,
  OrganizationResponseDto,
  TransferOwnershipRequestDto,
  UpdateOrganizationRequestDto,
} from './dto/organization.dto';
import type { OrganizationRequest } from './guards/organization-access';
import { RequireOrgPermission } from './guards/organization-access';
import { OrganizationAccessGuard } from './guards/organization-access.guard';
import { OrgPermission, OrgRole } from './organization-permissions';
import { OrganizationsService } from './organizations.service';

@ApiTags('Organizations')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED: missing or invalid access token')
@UseGuards(OrganizationAccessGuard)
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create an organization',
    description: 'You become its owner.',
  })
  @ApiCreatedResponse({ type: OrganizationResponseDto })
  @ApiValidationProblemResponse()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateOrganizationRequestDto,
  ): Promise<OrganizationResponseDto> {
    return OrganizationResponseDto.from(
      await this.organizations.create(user.id, body.name),
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List my organizations',
    description: 'With your role in each.',
  })
  @ApiOkResponse({ type: [OrganizationResponseDto] })
  async list(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrganizationResponseDto[]> {
    return (await this.organizations.listForUser(user.id)).map((o) =>
      OrganizationResponseDto.from(o),
    );
  }

  @Get(':organizationId')
  @RequireOrgPermission(OrgPermission.ReadOrganization)
  @AllowApiKey()
  @ApiSecurity(API_KEY_SCHEME)
  @ApiOperation({
    summary: 'Get an organization',
    description:
      'Also callable with an API key that has the organization:read scope.',
  })
  @ApiOkResponse({ type: OrganizationResponseDto })
  @ApiProblemResponse(404, 'ORGANIZATION_NOT_FOUND (also for non-members)')
  async get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Req() request: OrganizationRequest,
  ): Promise<OrganizationResponseDto> {
    const organization = await this.organizations.get(organizationId);
    if (request.apiKey) {
      return OrganizationResponseDto.forAccess(organization, null, [
        ...request.apiKey.scopes,
      ]);
    }
    return OrganizationResponseDto.from({
      organization,
      role: request.organizationAccess?.role ?? OrgRole.Viewer,
    });
  }

  @Patch(':organizationId')
  @RequireOrgPermission(OrgPermission.ManageOrganization)
  @ApiOperation({ summary: 'Rename an organization (owner)' })
  @ApiOkResponse({ type: OrganizationResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(403, 'ORGANIZATION_PERMISSION_DENIED')
  async update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: UpdateOrganizationRequestDto,
    @Req() request: OrganizationRequest,
  ): Promise<OrganizationResponseDto> {
    return OrganizationResponseDto.from({
      organization: await this.organizations.rename(organizationId, body.name),
      role: request.organizationAccess?.role ?? OrgRole.Owner,
    });
  }

  @Get(':organizationId/members')
  @RequireOrgPermission(OrgPermission.ReadOrganization)
  @ApiOperation({ summary: 'List members' })
  @ApiOkResponse({ type: [MemberResponseDto] })
  async members(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<MemberResponseDto[]> {
    return (await this.organizations.listMembers(organizationId)).map((m) =>
      MemberResponseDto.from(m),
    );
  }

  @Post(':organizationId/members')
  @RequireOrgPermission(OrgPermission.ManageMembers)
  @ApiOperation({ summary: 'Add an existing user as a member' })
  @ApiCreatedResponse({ type: MemberResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(403, 'ORGANIZATION_PERMISSION_DENIED')
  @ApiProblemResponse(409, 'MEMBER_ALREADY_EXISTS')
  @ApiProblemResponse(422, 'USER_NOT_FOUND')
  async addMember(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: AddMemberRequestDto,
  ): Promise<MemberResponseDto> {
    return MemberResponseDto.from(
      await this.organizations.addMember(organizationId, body.email, body.role),
    );
  }

  @Patch(':organizationId/members/:userId')
  @RequireOrgPermission(OrgPermission.ManageMembers)
  @ApiOperation({ summary: "Change a member's role" })
  @ApiOkResponse({ type: MemberResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(404, 'MEMBER_NOT_FOUND')
  @ApiProblemResponse(422, 'OWNER_CHANGE_NOT_ALLOWED')
  async changeRole(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: ChangeRoleRequestDto,
  ): Promise<MemberResponseDto> {
    return MemberResponseDto.from(
      await this.organizations.changeRole(organizationId, userId, body.role),
    );
  }

  @Delete(':organizationId/members/:userId')
  @RequireOrgPermission(OrgPermission.ManageMembers)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member' })
  @ApiNoContentResponse()
  @ApiProblemResponse(404, 'MEMBER_NOT_FOUND')
  @ApiProblemResponse(422, 'OWNER_CHANGE_NOT_ALLOWED')
  async removeMember(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.organizations.removeMember(organizationId, userId);
  }

  @Post(':organizationId/transfer-ownership')
  @RequireOrgPermission(OrgPermission.ManageOrganization)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Transfer ownership (owner)',
    description: 'The new owner must already be a member; you become an admin.',
  })
  @ApiNoContentResponse()
  @ApiProblemResponse(404, 'MEMBER_NOT_FOUND')
  async transferOwnership(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: TransferOwnershipRequestDto,
  ): Promise<void> {
    await this.organizations.transferOwnership(organizationId, body.userId);
  }
}
