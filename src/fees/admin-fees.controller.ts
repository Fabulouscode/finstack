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
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AppException } from '../common/http/app.exception';
import { toMinorUnits } from '../common/money/money';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { OrganizationsService } from '../organizations/organizations.service';
import { UserRole } from '../users/user.entity';
import {
  FeeRuleResponseDto,
  ListFeeRulesQueryDto,
  SetFeeRuleRequestDto,
} from './dto/fee.dto';
import { FeesService } from './fees.service';

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@Roles(UserRole.Admin)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'FORBIDDEN: admin role required')
@Controller('admin/fee-rules')
export class AdminFeesController {
  constructor(
    private readonly fees: FeesService,
    private readonly organizations: OrganizationsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List fee rules',
    description: 'Active rules; `history=true` includes superseded ones.',
  })
  @ApiOkResponse({ type: [FeeRuleResponseDto] })
  @ApiValidationProblemResponse()
  async list(
    @Query() query: ListFeeRulesQueryDto,
  ): Promise<FeeRuleResponseDto[]> {
    return (
      await this.fees.list({ ...query, includeHistory: query.history })
    ).map((rule) => FeeRuleResponseDto.from(rule));
  }

  @Post()
  @ApiOperation({
    summary: 'Set a fee rule',
    description:
      'fixed + amount × bps, rounded up, within [min, max]. Replaces the active rule for the same operation, currency and organization (the old one is kept, superseded). ' +
      'Charged fees keep the rule they used. Takes effect for operations started from now on. Audited.',
  })
  @ApiCreatedResponse({ type: FeeRuleResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(404, 'ORGANIZATION_NOT_FOUND')
  @ApiProblemResponse(422, 'INVALID_FEE_RULE: maxAmount below minAmount')
  async set(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() body: SetFeeRuleRequestDto,
  ): Promise<FeeRuleResponseDto> {
    if (body.maxAmount !== undefined && body.maxAmount < body.minAmount) {
      throw new AppException(
        'INVALID_FEE_RULE',
        'maxAmount cannot be below minAmount',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (body.organizationId) {
      await this.organizations.get(body.organizationId);
    }
    return FeeRuleResponseDto.from(
      await this.fees.setRule(admin.id, {
        operation: body.operation,
        currency: body.currency,
        organizationId: body.organizationId ?? null,
        fixedAmount: toMinorUnits(body.fixedAmount),
        percentageBps: body.percentageBps,
        minAmount: toMinorUnits(body.minAmount),
        maxAmount:
          body.maxAmount === undefined ? null : toMinorUnits(body.maxAmount),
      }),
    );
  }

  @Post(':ruleId/retire')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retire a fee rule',
    description:
      'Ends it without a replacement: an organization falls back to the platform default; a default falls back to no fee. Audited.',
  })
  @ApiOkResponse({ type: FeeRuleResponseDto })
  @ApiProblemResponse(404, 'FEE_RULE_NOT_FOUND')
  @ApiProblemResponse(409, 'FEE_RULE_ALREADY_RETIRED')
  async retire(
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
  ): Promise<FeeRuleResponseDto> {
    return FeeRuleResponseDto.from(await this.fees.retire(ruleId));
  }
}
