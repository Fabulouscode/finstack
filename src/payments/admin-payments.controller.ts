import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { ApiProblemResponse } from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { UserRole } from '../users/user.entity';
import { PaymentResponseDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';
import { SettlementReleaseService } from './settlement-release.service';

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@Roles(UserRole.Admin)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'FORBIDDEN: admin role required')
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly release: SettlementReleaseService,
  ) {}

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
