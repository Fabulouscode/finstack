import {
  Body,
  Controller,
  Get,
  Headers,
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
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { toMinorUnits } from '../common/money/money';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { Idempotent } from '../idempotency/idempotent.decorator';
import { IDEMPOTENCY_KEY_HEADER } from '../idempotency/idempotency.interceptor';
import {
  CreateTransferRequestDto,
  ListTransactionsQueryDto,
  TransactionResponseDto,
  TransactionsPageDto,
} from './dto/transaction.dto';
import { TransactionsService } from './transactions.service';
import { TransfersService } from './transfers.service';

@ApiTags('Transactions')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED: missing or invalid access token')
@Controller()
export class TransactionsController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly transfers: TransfersService,
  ) {}

  @Post('transfers')
  @Idempotent()
  @ApiOperation({
    summary: 'Send money to another user',
    description:
      "Moves money from your wallet to the recipient's wallet in the same currency, atomically. " +
      'Requires an Idempotency-Key: retries return the original result and never send twice.',
  })
  @ApiCreatedResponse({ type: TransactionResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(
    422,
    'INSUFFICIENT_FUNDS | RECIPIENT_NOT_FOUND | SELF_TRANSFER | NO_WALLET_IN_CURRENCY | RECIPIENT_CANNOT_RECEIVE_CURRENCY | WALLET_NOT_ACTIVE',
  )
  async transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateTransferRequestDto,
    @Headers(IDEMPOTENCY_KEY_HEADER.toLowerCase()) idempotencyKey: string,
  ): Promise<TransactionResponseDto> {
    const transaction = await this.transfers.transfer(
      user.id,
      {
        recipientEmail: body.recipientEmail,
        amount: toMinorUnits(body.amount),
        currency: body.currency,
        description: body.description,
      },
      idempotencyKey,
    );
    return TransactionResponseDto.from(transaction, user.id);
  }

  @Get('transactions')
  @ApiOperation({
    summary: 'List my transactions',
    description: 'Outgoing and incoming, newest first, with cursor pagination.',
  })
  @ApiOkResponse({ type: TransactionsPageDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(400, 'INVALID_CURSOR: the cursor is malformed')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListTransactionsQueryDto,
  ): Promise<TransactionsPageDto> {
    const page = await this.transactions.listForUser(user.id, {
      limit: query.limit,
      before: query.cursor ? decodeCursor(query.cursor) : undefined,
    });
    return {
      data: page.transactions.map((t) =>
        TransactionResponseDto.from(t, user.id),
      ),
      nextCursor: page.next ? encodeCursor(page.next) : null,
    };
  }

  @Get('transactions/:transactionId')
  @ApiOperation({ summary: 'Get a transaction' })
  @ApiOkResponse({ type: TransactionResponseDto })
  @ApiProblemResponse(404, 'TRANSACTION_NOT_FOUND')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
  ): Promise<TransactionResponseDto> {
    return TransactionResponseDto.from(
      await this.transactions.getForUser(user.id, transactionId),
      user.id,
    );
  }
}
