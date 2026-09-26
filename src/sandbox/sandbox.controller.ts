import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { toMinorUnits } from '../common/money/money';
import { organizationOwner, OwnerRef } from '../common/owner/owner';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME, API_KEY_SCHEME } from '../docs/swagger';
import { RequireOrgPermission } from '../organizations/guards/organization-access';
import { OrganizationAccessGuard } from '../organizations/guards/organization-access.guard';
import { OrgPermission } from '../organizations/organization-permissions';
import { PaymentResponseDto } from '../payments/dto/payment.dto';
import { PayoutResponseDto } from '../payouts/dto/payout.dto';
import {
  CompletePaymentRequestDto,
  CompletePayoutRequestDto,
  FundWalletRequestDto,
} from './dto/sandbox.dto';
import { SandboxService } from './sandbox.service';

const SANDBOX_NOTE =
  'Sandbox only (mock provider enabled; 404 elsewhere). Runs through the real signed-webhook pipeline.';

class SandboxActions {
  constructor(protected readonly sandbox: SandboxService) {}

  protected async fund(
    owner: OwnerRef,
    body: FundWalletRequestDto,
  ): Promise<PaymentResponseDto> {
    return PaymentResponseDto.from(
      await this.sandbox.fund(owner, toMinorUnits(body.amount), body.currency),
    );
  }

  protected async payment(
    owner: OwnerRef,
    paymentId: string,
    body: CompletePaymentRequestDto,
  ): Promise<PaymentResponseDto> {
    return PaymentResponseDto.from(
      await this.sandbox.completePayment(
        owner,
        paymentId,
        body.outcome,
        body.collectedAmount !== undefined
          ? toMinorUnits(body.collectedAmount)
          : undefined,
      ),
    );
  }

  protected async payout(
    owner: OwnerRef,
    payoutId: string,
    body: CompletePayoutRequestDto,
  ): Promise<PayoutResponseDto> {
    return PayoutResponseDto.from(
      await this.sandbox.completePayout(owner, payoutId, body.outcome),
    );
  }
}

@ApiTags('Sandbox')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(404, 'NOT_FOUND: not a sandbox, or not your payment/payout')
@Controller('sandbox')
export class SandboxController extends SandboxActions {
  constructor(sandbox: SandboxService) {
    super(sandbox);
  }

  @Post('wallets/fund')
  @ApiOperation({
    summary: 'Add test money to my wallet',
    description: SANDBOX_NOTE,
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiValidationProblemResponse()
  fundWallet(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: FundWalletRequestDto,
  ): Promise<PaymentResponseDto> {
    return this.fund(user.id, body);
  }

  @Post('payments/:paymentId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pay (or fail) one of my pending mock payments',
    description: SANDBOX_NOTE,
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(409, 'NOT_SIMULATABLE')
  completePayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() body: CompletePaymentRequestDto,
  ): Promise<PaymentResponseDto> {
    return this.payment(user.id, paymentId, body);
  }

  @Post('payouts/:payoutId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete, fail or reverse one of my mock payouts',
    description: `${SANDBOX_NOTE} Test accounts: numbers ending 0001 are rejected at once, 0002 stay pending until completed here.`,
  })
  @ApiOkResponse({ type: PayoutResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(409, 'NOT_SIMULATABLE')
  completePayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('payoutId', ParseUUIDPipe) payoutId: string,
    @Body() body: CompletePayoutRequestDto,
  ): Promise<PayoutResponseDto> {
    return this.payout(user.id, payoutId, body);
  }
}

@ApiTags('Sandbox')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiSecurity(API_KEY_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(404, 'NOT_FOUND: not a sandbox, or not the organization’s')
@AllowApiKey()
@UseGuards(OrganizationAccessGuard)
@Controller('organizations/:organizationId/sandbox')
export class OrganizationSandboxController extends SandboxActions {
  constructor(sandbox: SandboxService) {
    super(sandbox);
  }

  @Post('wallets/fund')
  @RequireOrgPermission(OrgPermission.CreatePayments)
  @ApiOperation({
    summary: "Add test money to the organization's wallet",
    description: SANDBOX_NOTE,
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiValidationProblemResponse()
  fundWallet(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: FundWalletRequestDto,
  ): Promise<PaymentResponseDto> {
    return this.fund(organizationOwner(organizationId), body);
  }

  @Post('payments/:paymentId/complete')
  @HttpCode(HttpStatus.OK)
  @RequireOrgPermission(OrgPermission.CreatePayments)
  @ApiOperation({
    summary: 'Pay (or fail) a pending mock payment',
    description: SANDBOX_NOTE,
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(409, 'NOT_SIMULATABLE')
  completePayment(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() body: CompletePaymentRequestDto,
  ): Promise<PaymentResponseDto> {
    return this.payment(organizationOwner(organizationId), paymentId, body);
  }

  @Post('payouts/:payoutId/complete')
  @HttpCode(HttpStatus.OK)
  @RequireOrgPermission(OrgPermission.CreatePayouts)
  @ApiOperation({
    summary: 'Complete, fail or reverse a mock payout',
    description: SANDBOX_NOTE,
  })
  @ApiOkResponse({ type: PayoutResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(409, 'NOT_SIMULATABLE')
  completePayout(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('payoutId', ParseUUIDPipe) payoutId: string,
    @Body() body: CompletePayoutRequestDto,
  ): Promise<PayoutResponseDto> {
    return this.payout(organizationOwner(organizationId), payoutId, body);
  }
}
