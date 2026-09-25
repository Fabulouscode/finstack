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
import { Roles } from '../auth/decorators/roles.decorator';
import { toMinorUnits } from '../common/money/money';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { Idempotent } from '../idempotency/idempotent.decorator';
import { IDEMPOTENCY_KEY_HEADER } from '../idempotency/idempotency.interceptor';
import { UserRole } from '../users/user.entity';
import { CreateRefundRequestDto, RefundResponseDto } from './dto/refund.dto';
import { RefundsService } from './refunds.service';

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@Roles(UserRole.Admin)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'FORBIDDEN: admin role required')
@Controller('admin')
export class AdminRefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post('payments/:paymentId/refunds')
  @Idempotent()
  @ApiOperation({
    summary: 'Refund a payment (full or partial)',
    description:
      'Holds the amount in the wallet, asks the provider to refund, and settles when the provider confirms. ' +
      'Converted payments are refunded at the ORIGINAL rate, margin included, so the customer gets back exactly what they paid (in proportion for partial refunds). ' +
      'The total refunded can never exceed the payment.',
  })
  @ApiCreatedResponse({ type: RefundResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(404, 'PAYMENT_NOT_FOUND')
  @ApiProblemResponse(
    422,
    'PAYMENT_NOT_REFUNDABLE | PAYMENT_ALREADY_REFUNDED | REFUND_EXCEEDS_REMAINING | INSUFFICIENT_FUNDS (the wallet already spent it) | WALLET_NOT_ACTIVE',
  )
  async create(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() body: CreateRefundRequestDto,
    @Headers(IDEMPOTENCY_KEY_HEADER.toLowerCase()) idempotencyKey: string,
  ): Promise<RefundResponseDto> {
    return RefundResponseDto.from(
      await this.refunds.request(
        admin.id,
        paymentId,
        {
          amount:
            body.amount !== undefined ? toMinorUnits(body.amount) : undefined,
          reason: body.reason,
        },
        idempotencyKey,
      ),
    );
  }

  @Get('refunds/:refundId')
  @ApiOperation({ summary: 'Get a refund' })
  @ApiOkResponse({ type: RefundResponseDto })
  @ApiProblemResponse(404, 'REFUND_NOT_FOUND')
  async get(
    @Param('refundId', ParseUUIDPipe) refundId: string,
  ): Promise<RefundResponseDto> {
    return RefundResponseDto.from(await this.refunds.view(refundId));
  }

  @Post('refunds/:refundId/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a refund stuck in processing',
    description:
      'Re-asks the provider (idempotent by the refund reference). No effect on settled refunds.',
  })
  @ApiOkResponse({ type: RefundResponseDto })
  @ApiProblemResponse(404, 'REFUND_NOT_FOUND')
  async retry(
    @Param('refundId', ParseUUIDPipe) refundId: string,
  ): Promise<RefundResponseDto> {
    return RefundResponseDto.from(await this.refunds.retry(refundId));
  }
}
