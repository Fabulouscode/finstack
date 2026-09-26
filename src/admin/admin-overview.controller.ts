import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { ApiProblemResponse } from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { UserRole } from '../users/user.entity';
import { AdminService } from './admin.service';
import { AdminOverviewResponseDto, BalanceTotalsDto } from './dto/admin.dto';

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@Roles(UserRole.Admin)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'FORBIDDEN: admin role required')
@ApiExtraModels(BalanceTotalsDto)
@Controller('admin/overview')
export class AdminOverviewController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  @ApiOperation({
    summary: 'Platform overview',
    description:
      'Users and organizations by status, what is owed to wallet holders per currency, and what needs attention: ' +
      'payouts and refunds still processing, open reconciliation items, failed webhooks, disabled endpoints.',
  })
  @ApiOkResponse({ type: AdminOverviewResponseDto })
  async overview(): Promise<AdminOverviewResponseDto> {
    return AdminOverviewResponseDto.from(await this.admin.overview());
  }
}
