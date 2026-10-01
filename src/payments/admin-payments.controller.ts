import {
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
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { PlatformPermission } from '../auth/platform-permissions';
import { encodeCursor } from '../common/pagination/cursor';
import { AdminOwnedMoneyListQueryDto } from '../common/pagination/admin-list-query.dto';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { AdminPaymentsPageDto, PaymentResponseDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';
import { SettlementReleaseService } from './settlement-release.service';

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@RequirePermission(PlatformPermission.ManagePayments)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(
  403,
  'FORBIDDEN: your platform role lacks the required permission',
)
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly release: SettlementReleaseService,
  ) {}

  @Get()
  @RequirePermission(PlatformPermission.ReadPayments)
  @ApiOperation({
    summary: 'List payments',
    description:
      "Every user's and organization's payments, newest first. Filter by status, provider, currency or owner.",
  })
  @ApiOkResponse({ type: AdminPaymentsPageDto })
  @ApiValidationProblemResponse()
  async list(
    @Query() query: AdminOwnedMoneyListQueryDto,
  ): Promise<AdminPaymentsPageDto> {
    const { views, next } = await this.payments.searchForAdmin(
      query,
      query.page(),
    );
    return {
      data: views.map((view) => PaymentResponseDto.from(view)),
      nextCursor: next ? encodeCursor(next) : null,
    };
  }

  @Get(':paymentId')
  @RequirePermission(PlatformPermission.ReadPayments)
  @ApiOperation({ summary: 'Get any payment' })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiProblemResponse(404, 'PAYMENT_NOT_FOUND')
  async get(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<PaymentResponseDto> {
    return PaymentResponseDto.from(
      await this.payments.view(await this.payments.getById(paymentId)),
    );
  }

  @Post(':paymentId/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "End a payment's settlement hold now",
    description:
      'Moves what is still pending from the payment to the available balance before PAYMENT_SETTLEMENT_DELAY_SECONDS has passed. Audited; a no-op if nothing is held.',
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiProblemResponse(404, 'PAYMENT_NOT_FOUND')
  async releaseNow(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<PaymentResponseDto> {
    const payment = await this.release.releaseEarly(paymentId);
    return PaymentResponseDto.from(await this.payments.view(payment));
  }
}
