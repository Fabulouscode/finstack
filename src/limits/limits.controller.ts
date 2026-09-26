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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { AllowApiKey } from '../api-keys/api-key-principal';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { toMinorUnits } from '../common/money/money';
import { organizationOwner } from '../common/owner/owner';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME, API_KEY_SCHEME } from '../docs/swagger';
import { RequireOrgPermission } from '../organizations/guards/organization-access';
import { OrganizationAccessGuard } from '../organizations/guards/organization-access.guard';
import { OrgPermission } from '../organizations/organization-permissions';
import { OrganizationsService } from '../organizations/organizations.service';
import { UserRole } from '../users/user.entity';
import {
  LimitRuleResponseDto,
  LimitUsageResponseDto,
  ListLimitRulesQueryDto,
  SetLimitRuleRequestDto,
} from './dto/limit.dto';
import { LimitsService } from './limits.service';

@ApiTags('Limits')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@Controller('limits')
export class LimitsController {
  constructor(private readonly limits: LimitsService) {}

  @Get()
  @ApiOperation({
    summary: 'My limits and what I have used',
    description:
      'Per operation and currency, over rolling 24 hours and 30 days.',
  })
  @ApiOkResponse({ type: [LimitUsageResponseDto] })
  async mine(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LimitUsageResponseDto[]> {
    return (await this.limits.usageFor(user.id)).map((usage) =>
      LimitUsageResponseDto.from(usage),
    );
  }
}

@ApiTags('Limits')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiSecurity(API_KEY_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(404, 'ORGANIZATION_NOT_FOUND')
@AllowApiKey()
@UseGuards(OrganizationAccessGuard)
@Controller('organizations/:organizationId/limits')
export class OrganizationLimitsController {
  constructor(private readonly limits: LimitsService) {}

  @Get()
  @RequireOrgPermission(OrgPermission.ReadOrganization)
  @ApiOperation({ summary: "The organization's limits and usage" })
  @ApiOkResponse({ type: [LimitUsageResponseDto] })
  async list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<LimitUsageResponseDto[]> {
    return (await this.limits.usageFor(organizationOwner(organizationId))).map(
      (usage) => LimitUsageResponseDto.from(usage),
    );
  }
}

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@Roles(UserRole.Admin)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'FORBIDDEN: admin role required')
@Controller('admin/limit-rules')
export class AdminLimitsController {
  constructor(
    private readonly limits: LimitsService,
    private readonly organizations: OrganizationsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List limit rules',
    description: '`history=true` includes superseded ones.',
  })
  @ApiOkResponse({ type: [LimitRuleResponseDto] })
  @ApiValidationProblemResponse()
  async list(
    @Query() query: ListLimitRulesQueryDto,
  ): Promise<LimitRuleResponseDto[]> {
    return (
      await this.limits.list({ ...query, includeHistory: query.history })
    ).map((rule) => LimitRuleResponseDto.from(rule));
  }

  @Post()
  @ApiOperation({
    summary: 'Set a limit rule',
    description:
      'Caps per transaction, per rolling 24 hours (amount and count) and per rolling 30 days; omitted caps are unlimited. ' +
      'Replaces the active rule for the same operation, currency and organization. Audited.',
  })
  @ApiCreatedResponse({ type: LimitRuleResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(404, 'ORGANIZATION_NOT_FOUND')
  async set(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() body: SetLimitRuleRequestDto,
  ): Promise<LimitRuleResponseDto> {
    if (body.organizationId) {
      await this.organizations.get(body.organizationId);
    }
    const minor = (value?: number): bigint | null =>
      value === undefined ? null : toMinorUnits(value);
    return LimitRuleResponseDto.from(
      await this.limits.setRule(admin.id, {
        operation: body.operation,
        currency: body.currency,
        organizationId: body.organizationId ?? null,
        maxPerTransaction: minor(body.maxPerTransaction),
        maxDailyAmount: minor(body.maxDailyAmount),
        maxDailyCount: body.maxDailyCount ?? null,
        maxMonthlyAmount: minor(body.maxMonthlyAmount),
      }),
    );
  }

  @Post(':ruleId/retire')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retire a limit rule',
    description: 'Falls back to the default, or no limit. Audited.',
  })
  @ApiOkResponse({ type: LimitRuleResponseDto })
  @ApiProblemResponse(404, 'LIMIT_RULE_NOT_FOUND')
  @ApiProblemResponse(409, 'LIMIT_RULE_ALREADY_RETIRED')
  async retire(
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
  ): Promise<LimitRuleResponseDto> {
    return LimitRuleResponseDto.from(await this.limits.retire(ruleId));
  }
}
