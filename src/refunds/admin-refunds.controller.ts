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
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { PlatformPermission } from '../auth/platform-permissions';
import { toMinorUnits } from '../common/money/money';
import { AdminMoneyListQueryDto } from '../common/pagination/admin-list-query.dto';
import { encodeCursor } from '../common/pagination/cursor';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { Idempotent } from '../idempotency/idempotent.decorator';
import { IdempotencyKey } from '../idempotency/idempotency-key.decorator';
import {
  AdminRefundsPageDto,
  CreateRefundRequestDto,
  RefundResponseDto,
} from './dto/refund.dto';
import { RefundsService } from './refunds.service';

class AdminRefundsQueryDto extends AdminMoneyListQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  paymentId?: string;
}

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@RequirePermission(PlatformPermission.ManageRefunds)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(
  403,
  'FORBIDDEN: your platform role lacks the required permission',
)
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
    @IdempotencyKey() idempotencyKey: string,
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

  @Get('refunds')
  @RequirePermission(PlatformPermission.ReadRefunds)
  @ApiOperation({
    summary: 'List refunds',
    description:
      'Newest first. Filter by status, provider, currency or payment (`paymentId`).',
  })
  @ApiOkResponse({ type: AdminRefundsPageDto })
  @ApiValidationProblemResponse()
  async list(
    @Query() query: AdminRefundsQueryDto,
  ): Promise<AdminRefundsPageDto> {
    const { views, next } = await this.refunds.search(query, query.page());
    return {
      data: views.map((view) => RefundResponseDto.from(view)),
      nextCursor: next ? encodeCursor(next) : null,
    };
  }

  @Get('refunds/:refundId')
  @RequirePermission(PlatformPermission.ReadRefunds)
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
