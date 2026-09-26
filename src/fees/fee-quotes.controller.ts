import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { AllowApiKey } from '../api-keys/api-key-principal';
import { toApiAmount, toMinorUnits } from '../common/money/money';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME, API_KEY_SCHEME } from '../docs/swagger';
import { RequireOrgPermission } from '../organizations/guards/organization-access';
import { OrganizationAccessGuard } from '../organizations/guards/organization-access.guard';
import { OrgPermission } from '../organizations/organization-permissions';
import { FeeQuoteQueryDto, FeeQuoteResponseDto } from './dto/fee.dto';
import { FeeOperation } from './fee-rule.entity';
import { FeesService } from './fees.service';

async function quote(
  fees: FeesService,
  query: FeeQuoteQueryDto,
  organizationId: string | null,
): Promise<FeeQuoteResponseDto> {
  const amount = toMinorUnits(query.amount);
  const fee = await fees.quote({
    operation: query.operation,
    currency: query.currency,
    amount,
    organizationId,
  });
  const total =
    query.operation === FeeOperation.Payment
      ? amount - fee.amount
      : amount + fee.amount;
  return {
    operation: query.operation,
    currency: query.currency,
    amount: query.amount,
    fee: toApiAmount(fee.amount),
    total: toApiAmount(total),
  };
}

@ApiTags('Fees')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@Controller('fees')
export class FeeQuotesController {
  constructor(private readonly fees: FeesService) {}

  @Get('quote')
  @ApiOperation({
    summary: 'What an operation will cost',
    description:
      'Payouts and transfers: the fee is added on top. Payments: it is taken from what the wallet receives.',
  })
  @ApiOkResponse({ type: FeeQuoteResponseDto })
  @ApiValidationProblemResponse()
  quote(@Query() query: FeeQuoteQueryDto): Promise<FeeQuoteResponseDto> {
    return quote(this.fees, query, null);
  }
}

@ApiTags('Fees')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiSecurity(API_KEY_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(404, 'ORGANIZATION_NOT_FOUND')
@AllowApiKey()
@UseGuards(OrganizationAccessGuard)
@Controller('organizations/:organizationId/fees')
export class OrganizationFeeQuotesController {
  constructor(private readonly fees: FeesService) {}

  @Get('quote')
  @RequireOrgPermission(OrgPermission.ReadOrganization)
  @ApiOperation({
    summary:
      'What an operation will cost this organization (its own rates if it has any)',
  })
  @ApiOkResponse({ type: FeeQuoteResponseDto })
  @ApiValidationProblemResponse()
  quote(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: FeeQuoteQueryDto,
  ): Promise<FeeQuoteResponseDto> {
    return quote(this.fees, query, organizationId);
  }
}
