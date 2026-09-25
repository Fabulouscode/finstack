import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
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
import { decodeCursor, encodeCursor } from '../common/pagination/cursor';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME, API_KEY_SCHEME } from '../docs/swagger';
import { RequireOrgPermission } from '../organizations/guards/organization-access';
import { OrganizationAccessGuard } from '../organizations/guards/organization-access.guard';
import { OrgPermission } from '../organizations/organization-permissions';
import {
  ListTransactionsQueryDto,
  organizationTransactionDto,
  TransactionResponseDto,
  TransactionsPageDto,
} from './dto/transaction.dto';
import { TransactionsService } from './transactions.service';

@ApiTags('Organization transactions')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiSecurity(API_KEY_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED: missing or invalid credentials')
@ApiProblemResponse(403, 'FORBIDDEN: your role or API key lacks the permission')
@ApiProblemResponse(404, 'ORGANIZATION_NOT_FOUND | TRANSACTION_NOT_FOUND')
@AllowApiKey()
@UseGuards(OrganizationAccessGuard)
@Controller('organizations/:organizationId/transactions')
export class OrganizationTransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get()
  @RequireOrgPermission(OrgPermission.ReadTransactions)
  @ApiOperation({
    summary: "List an organization's transactions",
    description:
      'Requires `transactions:read`. Payments in and refunds out, newest first.',
  })
  @ApiOkResponse({ type: TransactionsPageDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(400, 'INVALID_CURSOR: the cursor is malformed')
  async list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: ListTransactionsQueryDto,
  ): Promise<TransactionsPageDto> {
    const page = await this.transactions.listForOrganization(organizationId, {
      limit: query.limit,
      before: query.cursor ? decodeCursor(query.cursor) : undefined,
    });
    return {
      data: page.transactions.map(organizationTransactionDto),
      nextCursor: page.next ? encodeCursor(page.next) : null,
    };
  }

  @Get(':transactionId')
  @RequireOrgPermission(OrgPermission.ReadTransactions)
  @ApiOperation({ summary: 'Get one of the organization’s transactions' })
  @ApiOkResponse({ type: TransactionResponseDto })
  async get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
  ): Promise<TransactionResponseDto> {
    return organizationTransactionDto(
      await this.transactions.getForOrganization(organizationId, transactionId),
    );
  }
}
