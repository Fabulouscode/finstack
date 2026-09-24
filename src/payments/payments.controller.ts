import {
  Body,
  Controller,
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
  InitializePaymentRequestDto,
  PaymentResponseDto,
} from './dto/payment.dto';
import { PaymentSettlementService } from './payment-settlement.service';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED: missing or invalid access token')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly settlement: PaymentSettlementService,
  ) {}

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Start a payment into my wallet',
    description:
      'Creates a pending payment and a hosted checkout (`authorizationUrl`). The money lands in your wallet in that currency, ' +
      'or is converted into your primary wallet at a quote locked now (see `conversion`). ' +
      'Completion is confirmed by the provider webhook, or by calling POST /v1/payments/:id/verify.',
  })
  @ApiCreatedResponse({ type: PaymentResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(404, 'WALLET_NOT_FOUND: open a wallet first')
  @ApiProblemResponse(
    422,
    'UNKNOWN_PAYMENT_PROVIDER | FX_RATE_UNAVAILABLE | AMOUNT_TOO_SMALL',
  )
  @ApiProblemResponse(
    503,
    'PAYMENT_PROVIDER_UNAVAILABLE | FX_RATE_STALE: retry with the same key',
  )
  async initialize(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: InitializePaymentRequestDto,
    @Headers(IDEMPOTENCY_KEY_HEADER.toLowerCase()) idempotencyKey: string,
  ): Promise<PaymentResponseDto> {
    return PaymentResponseDto.from(
      await this.payments.initialize(
        user.id,
        {
          amount: toMinorUnits(body.amount),
          currency: body.currency,
          provider: body.provider,
          callbackUrl: body.callbackUrl,
        },
        idempotencyKey,
      ),
    );
  }

  @Get(':paymentId')
  @ApiOperation({ summary: 'Get one of my payments' })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiProblemResponse(404, 'PAYMENT_NOT_FOUND')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<PaymentResponseDto> {
    return PaymentResponseDto.from(
      await this.payments.getForUser(user.id, paymentId),
    );
  }

  @Post(':paymentId/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify a payment with the provider',
    description:
      "Asks the provider for the payment's real state and settles it (e.g. after the customer returns from checkout). " +
      'Safe to call repeatedly; the wallet is credited at most once.',
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiProblemResponse(404, 'PAYMENT_NOT_FOUND')
  @ApiProblemResponse(503, 'PAYMENT_PROVIDER_UNAVAILABLE')
  async verify(
    @CurrentUser() user: AuthenticatedUser,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<PaymentResponseDto> {
    const { payment } = await this.payments.getForUser(user.id, paymentId);
    await this.settlement.settle(payment);
    return PaymentResponseDto.from(
      await this.payments.getForUser(user.id, paymentId),
    );
  }
}
