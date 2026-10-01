import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import {
  PLATFORM_ROLE_PERMISSIONS,
  PlatformPermission,
} from '../auth/platform-permissions';
import { ApiProblemResponse } from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { PlatformRoleDto } from './dto/admin.dto';

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
// Every staff role can read the overview, so every staff member can ask.
@RequirePermission(PlatformPermission.ReadOverview)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'FORBIDDEN: not a staff member')
@Controller('admin/me')
export class AdminMeController {
  @Get()
  @ApiOperation({
    summary: 'Your platform role and what it allows',
    description:
      'For staff tools deciding what to show. The role is read fresh on every request, so a change applies at once. Every endpoint still enforces its own permission.',
  })
  @ApiOkResponse({ type: PlatformRoleDto })
  me(@CurrentUser() user: AuthenticatedUser): PlatformRoleDto {
    return {
      role: user.role,
      permissions: [...PLATFORM_ROLE_PERMISSIONS[user.role]],
    };
  }
}
