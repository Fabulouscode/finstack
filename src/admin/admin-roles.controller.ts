import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import {
  PLATFORM_ROLE_PERMISSIONS,
  PlatformPermission,
} from '../auth/platform-permissions';
import { ApiProblemResponse } from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { UserRole } from '../users/user.entity';
import { PlatformRoleDto } from './dto/admin.dto';

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@RequirePermission(PlatformPermission.ManageRoles)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(
  403,
  'FORBIDDEN: your platform role lacks the required permission',
)
@Controller('admin/roles')
export class AdminRolesController {
  @Get()
  @ApiOperation({ summary: 'Platform roles and what each can do' })
  @ApiOkResponse({ type: [PlatformRoleDto] })
  list(): PlatformRoleDto[] {
    return Object.values(UserRole).map((role) => ({
      role,
      permissions: [...PLATFORM_ROLE_PERMISSIONS[role]],
    }));
  }
}
