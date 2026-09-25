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
import { organizationOwner } from '../common/owner/owner';
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
  CreateWalletRequestDto,
  ListWalletEntriesQueryDto,
  WalletEntriesPageDto,
  WalletEntryDto,
  WalletResponseDto,
} from './dto/wallet.dto';
import { WalletsService } from './wallets.service';

/**
 * Wallets owned by an organization (e.g. a merchant's balance). Same rules
 * as user wallets (WALLETS_PER_OWNER, ALLOWED_WALLET_CURRENCIES); access by
 * membership role or API key scope.
 */
@ApiTags('Organization wallets')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiSecurity(API_KEY_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED: missing or invalid credentials')
@ApiProblemResponse(403, 'FORBIDDEN: your role or API key lacks the permission')
@ApiProblemResponse(404, 'ORGANIZATION_NOT_FOUND | WALLET_NOT_FOUND')
@AllowApiKey()
@UseGuards(OrganizationAccessGuard)
@Controller('organizations/:organizationId/wallets')
export class OrganizationWalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  @RequireOrgPermission(OrgPermission.ManageWallets)
  @ApiOperation({
    summary: "Open an organization's wallet",
    description:
      'Requires `wallets:manage`. The first wallet is the primary one.',
  })
  @ApiCreatedResponse({ type: WalletResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(409, 'WALLET_ALREADY_EXISTS')
  @ApiProblemResponse(422, 'WALLET_CURRENCY_NOT_ALLOWED')
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: CreateWalletRequestDto,
  ): Promise<WalletResponseDto> {
    return WalletResponseDto.from(
      await this.wallets.create(
        organizationOwner(organizationId),
        body.currency,
      ),
    );
  }

  @Get()
  @RequireOrgPermission(OrgPermission.ReadWallets)
  @ApiOperation({
    summary: "List an organization's wallets",
    description: 'Requires `wallets:read`. Primary wallet first.',
  })
  @ApiOkResponse({ type: [WalletResponseDto] })
  async list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<WalletResponseDto[]> {
    return (await this.wallets.listFor(organizationOwner(organizationId))).map(
      (wallet) => WalletResponseDto.from(wallet),
    );
  }

  @Get(':walletId')
  @RequireOrgPermission(OrgPermission.ReadWallets)
  @ApiOperation({ summary: 'Get an organization wallet with its balances' })
  @ApiOkResponse({ type: WalletResponseDto })
  async get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('walletId', ParseUUIDPipe) walletId: string,
  ): Promise<WalletResponseDto> {
    return WalletResponseDto.from(
      await this.wallets.getOwned(organizationOwner(organizationId), walletId),
    );
  }

  @Post(':walletId/primary')
  @HttpCode(HttpStatus.OK)
  @RequireOrgPermission(OrgPermission.ManageWallets)
  @ApiOperation({
    summary: 'Make an organization wallet primary',
    description:
      'Requires `wallets:manage`. The primary wallet receives payments in currencies the organization has no wallet for, after FX conversion.',
  })
  @ApiOkResponse({ type: WalletResponseDto })
  @ApiProblemResponse(422, 'WALLET_NOT_ACTIVE')
  async makePrimary(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('walletId', ParseUUIDPipe) walletId: string,
  ): Promise<WalletResponseDto> {
    return WalletResponseDto.from(
      await this.wallets.setPrimary(
        organizationOwner(organizationId),
        walletId,
      ),
    );
  }

  @Get(':walletId/entries')
  @RequireOrgPermission(OrgPermission.ReadWallets)
  @ApiOperation({
    summary: 'List organization wallet entries',
    description:
      'Requires `wallets:read`. Ledger entries on the available balance, newest first.',
  })
  @ApiOkResponse({ type: WalletEntriesPageDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(400, 'INVALID_CURSOR: the cursor is malformed')
  async entries(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query() query: ListWalletEntriesQueryDto,
  ): Promise<WalletEntriesPageDto> {
    const page = await this.wallets.listEntries(
      organizationOwner(organizationId),
      walletId,
      {
        limit: query.limit,
        before: query.cursor ? decodeCursor(query.cursor) : undefined,
      },
    );
    return {
      data: page.entries.map((entry) => WalletEntryDto.from(entry)),
      nextCursor: page.next ? encodeCursor(page.next) : null,
    };
  }
}
