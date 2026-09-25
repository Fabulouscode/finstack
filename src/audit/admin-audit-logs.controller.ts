import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { UserRole } from '../users/user.entity';
import { AuditService } from './audit.service';
import {
  AdminListAuditLogsQueryDto,
  AuditLogResponseDto,
  AuditLogsPageDto,
} from './dto/audit-log.dto';

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@Roles(UserRole.Admin)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'FORBIDDEN: admin role required')
@Controller('admin/audit-logs')
export class AdminAuditLogsController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({
    summary: 'Search the audit log',
    description:
      'Every audited action across the platform, newest first. Filter by organization, actor, action or target.',
  })
  @ApiOkResponse({ type: AuditLogsPageDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(400, 'INVALID_CURSOR')
  async list(
    @Query() query: AdminListAuditLogsQueryDto,
  ): Promise<AuditLogsPageDto> {
    const { limit, cursor, ...filter } = query;
    const page = await this.audit.list(filter, {
      limit,
      before: cursor ? decodeCursor(cursor) : undefined,
    });
    return {
      data: page.entries.map((entry) => AuditLogResponseDto.from(entry)),
      nextCursor: page.next ? encodeCursor(page.next) : null,
    };
  }
}
