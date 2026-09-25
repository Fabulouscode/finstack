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
  InitializeOrganizationPaymentRequestDto,
  PaymentResponseDto,
} from './dto/payment.dto';
import { PaymentSettlementService } from './payment-settlement.service';
import { PaymentsService } from './payments.service';

/**
 * Collections: customers pay an organization, and the money lands in the
 * organization's wallets under the same crediting rule as user top-ups.
 */
@ApiTags('Organization payments')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiSecurity(API_KEY_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED: missing or invalid credentials')
@ApiProblemResponse(403, 'FORBIDDEN: your role or API key lacks the permission')
@ApiProblemResponse(404, 'ORGANIZATION_NOT_FOUND | PAYMENT_NOT_FOUND')
@AllowApiKey()
@UseGuards(OrganizationAccessGuard)
@Controller('organizations/:organizationId/payments')
export class OrganizationPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly settlement: PaymentSettlementService,
  ) {}

  @Post()
  @Idempotent()
  @RequireOrgPermission(OrgPermission.CreatePayments)
  @ApiOperation({
    summary: 'Collect a payment from a customer',
    description:
      'Requires `payments:create`. Creates a pending payment and a hosted checkout for the customer. ' +
      "The money lands in the organization's wallet in that currency, or is converted into its primary wallet at a locked quote. " +
      'Idempotency-Key is scoped to the organization, so members and API keys share one key space.',
  })
  @ApiCreatedResponse({ type: PaymentResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(
    422,
    'UNKNOWN_PAYMENT_PROVIDER | FX_RATE_UNAVAILABLE | AMOUNT_TOO_SMALL',
  )
  @ApiProblemResponse(
    503,
    'PAYMENT_PROVIDER_UNAVAILABLE | FX_RATE_STALE: retry with the same key',
  )
  async initialize(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: InitializeOrganizationPaymentRequestDto,
    @Headers(IDEMPOTENCY_KEY_HEADER.toLowerCase()) idempotencyKey: string,
  ): Promise<PaymentResponseDto> {
    return PaymentResponseDto.from(
      await this.payments.initialize(
        organizationOwner(organizationId),
        {
          amount: toMinorUnits(body.amount),
          currency: body.currency,
          provider: body.provider,
          callbackUrl: body.callbackUrl,
          customerEmail: body.customerEmail,
        },
        idempotencyKey,
      ),
    );
  }

  @Get(':paymentId')
  @RequireOrgPermission(OrgPermission.ReadTransactions)
  @ApiOperation({
    summary: 'Get one of the organization’s payments',
    description: 'Requires `transactions:read`.',
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  async get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<PaymentResponseDto> {
    return PaymentResponseDto.from(
      await this.payments.getOwned(
        organizationOwner(organizationId),
        paymentId,
      ),
    );
  }

  @Post(':paymentId/verify')
  @HttpCode(HttpStatus.OK)
  @RequireOrgPermission(OrgPermission.CreatePayments)
  @ApiOperation({
    summary: 'Verify an organization payment with the provider',
    description:
      'Requires `payments:create`. Settles the payment from the provider’s real state; safe to call repeatedly.',
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiProblemResponse(503, 'PAYMENT_PROVIDER_UNAVAILABLE')
  async verify(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<PaymentResponseDto> {
    const owner = organizationOwner(organizationId);
    const { payment } = await this.payments.getOwned(owner, paymentId);
    await this.settlement.settle(payment);
    return PaymentResponseDto.from(
      await this.payments.getOwned(owner, paymentId),
    );
  }
}
