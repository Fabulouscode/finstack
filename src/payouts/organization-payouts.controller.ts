import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { AllowApiKey } from '../api-keys/api-key-principal';
import { toMinorUnits } from '../common/money/money';
import { organizationOwner } from '../common/owner/owner';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME, API_KEY_SCHEME } from '../docs/swagger';
import { Idempotent } from '../idempotency/idempotent.decorator';
import { IDEMPOTENCY_KEY_HEADER } from '../idempotency/idempotency.interceptor';
import { RequireOrgPermission } from '../organizations/guards/organization-access';
import { OrganizationAccessGuard } from '../organizations/guards/organization-access.guard';
import { OrgPermission } from '../organizations/organization-permissions';
import {
  CreatePayoutDestinationRequestDto,
  CreatePayoutRequestDto,
  PayoutDestinationResponseDto,
  PayoutResponseDto,
} from './dto/payout.dto';
import { PayoutDestinationsService } from './payout-destinations.service';
import { PAYOUT_PROBLEMS } from './payouts.controller';
import { PayoutsService } from './payouts.service';

/**
 * Payouts from an organization's wallets. Saving bank accounts
 * (`payout_destinations:manage`) is separate from sending money
 * (`payouts:create`), and only the latter can be given to API keys.
 */
@ApiTags('Organization payouts')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED: missing or invalid credentials')
@ApiProblemResponse(403, 'FORBIDDEN: your role or API key lacks the permission')
@UseGuards(OrganizationAccessGuard)
@Controller('organizations/:organizationId')
export class OrganizationPayoutsController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly destinations: PayoutDestinationsService,
  ) {}

  @Post('payout-destinations')
  @RequireOrgPermission(OrgPermission.ManagePayoutDestinations)
  @ApiOperation({
    summary: "Save a bank account for the organization's payouts",
    description: 'Requires `payout_destinations:manage` (owner, admin).',
  })
  @ApiCreatedResponse({ type: PayoutDestinationResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(409, 'PAYOUT_DESTINATION_ALREADY_EXISTS')
  @ApiProblemResponse(
    422,
    'PAYOUT_DESTINATION_REJECTED | PAYOUTS_NOT_SUPPORTED',
  )
  async addDestination(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: CreatePayoutDestinationRequestDto,
  ): Promise<PayoutDestinationResponseDto> {
    return PayoutDestinationResponseDto.from(
      await this.destinations.add(organizationOwner(organizationId), body),
    );
  }

  @Get('payout-destinations')
  @AllowApiKey()
  @ApiSecurity(API_KEY_SCHEME)
  @RequireOrgPermission(OrgPermission.CreatePayouts)
  @ApiOperation({
    summary: "List the organization's payout destinations",
    description: 'Requires `payouts:create`.',
  })
  @ApiOkResponse({ type: [PayoutDestinationResponseDto] })
  async listDestinations(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<PayoutDestinationResponseDto[]> {
    return (
      await this.destinations.list(organizationOwner(organizationId))
    ).map((destination) => PayoutDestinationResponseDto.from(destination));
  }

  @Delete('payout-destinations/:destinationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireOrgPermission(OrgPermission.ManagePayoutDestinations)
  @ApiOperation({ summary: 'Remove a payout destination' })
  @ApiNoContentResponse()
  @ApiProblemResponse(404, 'PAYOUT_DESTINATION_NOT_FOUND')
  async removeDestination(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('destinationId', ParseUUIDPipe) destinationId: string,
  ): Promise<void> {
    await this.destinations.remove(
      organizationOwner(organizationId),
      destinationId,
    );
  }

  @Post('payouts')
  @Idempotent()
  @AllowApiKey()
  @ApiSecurity(API_KEY_SCHEME)
  @RequireOrgPermission(OrgPermission.CreatePayouts)
  @ApiOperation({
    summary: "Pay out from the organization's wallet",
    description:
      'Requires `payouts:create`. The Idempotency-Key is shared by the organization’s members and API keys.',
  })
  @ApiCreatedResponse({ type: PayoutResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(404, 'PAYOUT_DESTINATION_NOT_FOUND | WALLET_NOT_FOUND')
  @ApiProblemResponse(422, PAYOUT_PROBLEMS)
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: CreatePayoutRequestDto,
    @Headers(IDEMPOTENCY_KEY_HEADER.toLowerCase()) idempotencyKey: string,
  ): Promise<PayoutResponseDto> {
    return PayoutResponseDto.from(
      await this.payouts.request(
        organizationOwner(organizationId),
        {
          destinationId: body.destinationId,
          amount: toMinorUnits(body.amount),
          walletId: body.walletId,
          narration: body.narration,
        },
        idempotencyKey,
      ),
    );
  }

  @Get('payouts/:payoutId')
  @AllowApiKey()
  @ApiSecurity(API_KEY_SCHEME)
  @RequireOrgPermission(OrgPermission.ReadTransactions)
  @ApiOperation({
    summary: 'Get one of the organization’s payouts',
    description: 'Requires `transactions:read`.',
  })
  @ApiOkResponse({ type: PayoutResponseDto })
  @ApiProblemResponse(404, 'PAYOUT_NOT_FOUND')
  async get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('payoutId', ParseUUIDPipe) payoutId: string,
  ): Promise<PayoutResponseDto> {
    return PayoutResponseDto.from(
      await this.payouts.getOwned(organizationOwner(organizationId), payoutId),
    );
  }
}
