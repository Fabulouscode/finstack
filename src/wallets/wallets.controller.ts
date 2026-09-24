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
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import {
  CreateWalletRequestDto,
  ListWalletEntriesQueryDto,
  WalletEntriesPageDto,
  WalletEntryDto,
  WalletResponseDto,
} from './dto/wallet.dto';
import { decodeCursor, encodeCursor } from './entry-cursor';
import { WalletsService } from './wallets.service';

@ApiTags('Wallets')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED: missing or invalid access token')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  @ApiOperation({
    summary: 'Open a wallet',
    description:
      'Opens a wallet in the given currency (default: DEFAULT_WALLET_CURRENCY). ' +
      'With WALLETS_PER_OWNER=single a user has one wallet; with `multiple`, one per allowed currency. ' +
      'The first wallet is the primary one.',
  })
  @ApiCreatedResponse({ type: WalletResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(
    409,
    'WALLET_ALREADY_EXISTS: the user already has a wallet (single) or one in this currency (multiple)',
  )
  @ApiProblemResponse(
    422,
    'WALLET_CURRENCY_NOT_ALLOWED: the operator does not allow this currency (ALLOWED_WALLET_CURRENCIES)',
  )
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateWalletRequestDto,
  ): Promise<WalletResponseDto> {
    return WalletResponseDto.from(
      await this.wallets.create(user.id, body.currency),
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List my wallets',
    description: 'Primary wallet first.',
  })
  @ApiOkResponse({ type: [WalletResponseDto] })
  async list(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WalletResponseDto[]> {
    return (await this.wallets.listForUser(user.id)).map((wallet) =>
      WalletResponseDto.from(wallet),
    );
  }

  // Declared before ':walletId' so "primary" is not parsed as an id.
  @Get('primary')
  @ApiOperation({ summary: 'Get my primary wallet' })
  @ApiOkResponse({ type: WalletResponseDto })
  @ApiProblemResponse(
    404,
    'WALLET_NOT_FOUND: the user has not opened a wallet yet',
  )
  async primary(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WalletResponseDto> {
    return WalletResponseDto.from(await this.wallets.getPrimary(user.id));
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Get a wallet with its balances' })
  @ApiOkResponse({ type: WalletResponseDto })
  @ApiProblemResponse(404, 'WALLET_NOT_FOUND: no such wallet for this user')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('walletId', ParseUUIDPipe) walletId: string,
  ): Promise<WalletResponseDto> {
    return WalletResponseDto.from(
      await this.wallets.getForUser(user.id, walletId),
    );
  }

  @Post(':walletId/primary')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Make a wallet primary',
    description:
      'The primary wallet receives payments in currencies the user has no wallet for, after FX conversion.',
  })
  @ApiOkResponse({ type: WalletResponseDto })
  @ApiProblemResponse(404, 'WALLET_NOT_FOUND: no such wallet for this user')
  @ApiProblemResponse(
    422,
    'WALLET_NOT_ACTIVE: frozen or closed wallets cannot be primary',
  )
  async makePrimary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('walletId', ParseUUIDPipe) walletId: string,
  ): Promise<WalletResponseDto> {
    return WalletResponseDto.from(
      await this.wallets.setPrimary(user.id, walletId),
    );
  }

  @Get(':walletId/entries')
  @ApiOperation({
    summary: 'List wallet entries',
    description:
      'Ledger entries on the available balance, newest first, with cursor pagination.',
  })
  @ApiOkResponse({ type: WalletEntriesPageDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(400, 'INVALID_CURSOR: the cursor is malformed')
  @ApiProblemResponse(404, 'WALLET_NOT_FOUND: no such wallet for this user')
  async entries(
    @CurrentUser() user: AuthenticatedUser,
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query() query: ListWalletEntriesQueryDto,
  ): Promise<WalletEntriesPageDto> {
    const page = await this.wallets.listEntriesForUser(user.id, walletId, {
      limit: query.limit,
      before: query.cursor ? decodeCursor(query.cursor) : undefined,
    });
    return {
      data: page.entries.map((entry) => WalletEntryDto.from(entry)),
      nextCursor: page.next ? encodeCursor(page.next) : null,
    };
  }
}
