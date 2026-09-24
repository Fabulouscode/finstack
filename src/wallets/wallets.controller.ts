import {
  Body,
  Controller,
  Get,
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
      'Opens a wallet in the given currency. One wallet per currency per user.',
  })
  @ApiCreatedResponse({ type: WalletResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(
    409,
    'WALLET_ALREADY_EXISTS: a wallet in this currency exists',
  )
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateWalletRequestDto,
  ): Promise<WalletResponseDto> {
    return WalletResponseDto.from(
      await this.wallets.create(user.id, body.currency),
    );
  }

  // Declared before ':walletId' so "me" is not parsed as an id.
  @Get('me')
  @ApiOperation({ summary: 'Get my wallet with its balances' })
  @ApiOkResponse({ type: WalletResponseDto })
  @ApiProblemResponse(
    404,
    'WALLET_NOT_FOUND: the user has not opened a wallet yet',
  )
  async mine(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WalletResponseDto> {
    return WalletResponseDto.from(await this.wallets.getMine(user.id));
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
