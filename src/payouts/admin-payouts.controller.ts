import {
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
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { ApiProblemResponse } from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { UserRole } from '../users/user.entity';
import { PayoutResponseDto } from './dto/payout.dto';
import { PayoutsService } from './payouts.service';

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@Roles(UserRole.Admin)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'FORBIDDEN: admin role required')
@Controller('admin/payouts')
export class AdminPayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get(':payoutId')
  @ApiOperation({ summary: 'Get any payout' })
  @ApiOkResponse({ type: PayoutResponseDto })
  @ApiProblemResponse(404, 'PAYOUT_NOT_FOUND')
  async get(
    @Param('payoutId', ParseUUIDPipe) payoutId: string,
  ): Promise<PayoutResponseDto> {
    return PayoutResponseDto.from(await this.payouts.view(payoutId));
  }

  @Post(':payoutId/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-check a payout with the provider',
    description:
      'Asks the provider for the real state and settles accordingly (also sends it if it never arrived). Safe to repeat.',
  })
  @ApiOkResponse({ type: PayoutResponseDto })
  @ApiProblemResponse(404, 'PAYOUT_NOT_FOUND')
  async sync(
    @Param('payoutId', ParseUUIDPipe) payoutId: string,
  ): Promise<PayoutResponseDto> {
    return PayoutResponseDto.from(await this.payouts.sync(payoutId));
  }
}
