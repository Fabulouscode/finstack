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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { toMinorUnits } from '../common/money/money';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { Idempotent } from '../idempotency/idempotent.decorator';
import { IDEMPOTENCY_KEY_HEADER } from '../idempotency/idempotency.interceptor';
import {
  CreatePayoutDestinationRequestDto,
  CreatePayoutRequestDto,
  PayoutDestinationResponseDto,
  PayoutResponseDto,
} from './dto/payout.dto';
import { PayoutDestinationsService } from './payout-destinations.service';
import { PayoutsService } from './payouts.service';

export const PAYOUT_PROBLEMS =
  'INSUFFICIENT_FUNDS | CURRENCY_MISMATCH | WALLET_NOT_ACTIVE | PAYOUTS_NOT_SUPPORTED';

@ApiTags('Payouts')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED: missing or invalid access token')
@Controller()
export class PayoutsController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly destinations: PayoutDestinationsService,
  ) {}

  @Post('payout-destinations')
  @ApiOperation({
    summary: 'Save a bank account for payouts',
    description:
      'Verified and saved with the provider (Nigerian accounts are name-checked). Only the last 4 digits are stored.',
  })
  @ApiCreatedResponse({ type: PayoutDestinationResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(409, 'PAYOUT_DESTINATION_ALREADY_EXISTS')
  @ApiProblemResponse(
    422,
    'PAYOUT_DESTINATION_REJECTED | PAYOUTS_NOT_SUPPORTED',
  )
  @ApiProblemResponse(503, 'PAYMENT_PROVIDER_UNAVAILABLE')
  async addDestination(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreatePayoutDestinationRequestDto,
  ): Promise<PayoutDestinationResponseDto> {
    return PayoutDestinationResponseDto.from(
      await this.destinations.add(user.id, body),
    );
  }

  @Get('payout-destinations')
  @ApiOperation({ summary: 'List my payout destinations' })
  @ApiOkResponse({ type: [PayoutDestinationResponseDto] })
  async listDestinations(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PayoutDestinationResponseDto[]> {
    return (await this.destinations.list(user.id)).map((destination) =>
      PayoutDestinationResponseDto.from(destination),
    );
  }

  @Delete('payout-destinations/:destinationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a payout destination' })
  @ApiNoContentResponse()
  @ApiProblemResponse(404, 'PAYOUT_DESTINATION_NOT_FOUND')
  async removeDestination(
    @CurrentUser() user: AuthenticatedUser,
    @Param('destinationId', ParseUUIDPipe) destinationId: string,
  ): Promise<void> {
    await this.destinations.remove(user.id, destinationId);
  }

  @Post('payouts')
  @Idempotent()
  @ApiOperation({
    summary: 'Withdraw to a bank account',
    description:
      'Holds the amount in your wallet and sends it through the provider. Usually `processing` at first; ' +
      'the provider webhook settles it (`successful`, or `failed` with the hold released). ' +
      'Requires an Idempotency-Key: a retry never pays out twice.',
  })
  @ApiCreatedResponse({ type: PayoutResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(404, 'PAYOUT_DESTINATION_NOT_FOUND | WALLET_NOT_FOUND')
  @ApiProblemResponse(422, PAYOUT_PROBLEMS)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreatePayoutRequestDto,
    @Headers(IDEMPOTENCY_KEY_HEADER.toLowerCase()) idempotencyKey: string,
  ): Promise<PayoutResponseDto> {
    return PayoutResponseDto.from(
      await this.payouts.request(
        user.id,
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
  @ApiOperation({ summary: 'Get one of my payouts' })
  @ApiOkResponse({ type: PayoutResponseDto })
  @ApiProblemResponse(404, 'PAYOUT_NOT_FOUND')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('payoutId', ParseUUIDPipe) payoutId: string,
  ): Promise<PayoutResponseDto> {
    return PayoutResponseDto.from(
      await this.payouts.getOwned(user.id, payoutId),
    );
  }
}
