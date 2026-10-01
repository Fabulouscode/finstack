import {
  Body,
  Controller,
  Get,
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
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { PlatformPermission } from '../auth/platform-permissions';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { WalletResponseDto } from '../wallets/dto/wallet.dto';
import { WalletStatus } from '../wallets/wallet.entity';
import { WalletWithBalances } from '../wallets/wallets.service';
import { WalletsService } from '../wallets/wallets.service';
import { AdminService } from './admin.service';
import { AdminReasonRequestDto } from './dto/admin.dto';

class AdminWalletDto extends WalletResponseDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  userId: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  organizationId: string | null;

  static fromWallet(view: WalletWithBalances): AdminWalletDto {
    return {
      ...WalletResponseDto.from(view),
      userId: view.wallet.userId,
      organizationId: view.wallet.organizationId,
    };
  }
}

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@RequirePermission(PlatformPermission.ReadWallets)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(
  403,
  'FORBIDDEN: your platform role lacks the required permission',
)
@ApiProblemResponse(404, 'WALLET_NOT_FOUND')
@Controller('admin/wallets')
export class AdminWalletsController {
  constructor(
    private readonly admin: AdminService,
    private readonly wallets: WalletsService,
  ) {}

  @Get(':walletId')
  @ApiOperation({ summary: 'Any wallet, with its balances and owner' })
  @ApiOkResponse({ type: AdminWalletDto })
  async get(
    @Param('walletId', ParseUUIDPipe) walletId: string,
  ): Promise<AdminWalletDto> {
    return AdminWalletDto.fromWallet(
      await this.wallets.getWithBalances(walletId),
    );
  }

  @RequirePermission(PlatformPermission.ManageWallets)
  @Post(':walletId/freeze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Freeze a wallet',
    description:
      'No money can leave it (transfers, payouts, conversions, refunds). Held funds can still be released. Audited with the reason.',
  })
  @ApiOkResponse({ type: AdminWalletDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(409, 'INVALID_STATUS_CHANGE')
  async freeze(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Body() body: AdminReasonRequestDto,
  ): Promise<AdminWalletDto> {
    return AdminWalletDto.fromWallet(
      await this.admin.setWalletStatus(
        walletId,
        WalletStatus.Frozen,
        body.reason,
      ),
    );
  }

  @RequirePermission(PlatformPermission.ManageWallets)
  @Post(':walletId/unfreeze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unfreeze a wallet' })
  @ApiOkResponse({ type: AdminWalletDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(409, 'INVALID_STATUS_CHANGE')
  async unfreeze(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Body() body: AdminReasonRequestDto,
  ): Promise<AdminWalletDto> {
    return AdminWalletDto.fromWallet(
      await this.admin.setWalletStatus(
        walletId,
        WalletStatus.Active,
        body.reason,
      ),
    );
  }
}
