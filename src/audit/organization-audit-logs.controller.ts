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
  ApiTags,
} from '@nestjs/swagger';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { RequireOrgPermission } from '../organizations/guards/organization-access';
import { OrganizationAccessGuard } from '../organizations/guards/organization-access.guard';
import { OrgPermission } from '../organizations/organization-permissions';
import { AuditService } from './audit.service';
import {
  AuditLogResponseDto,
  AuditLogsPageDto,
  ListAuditLogsQueryDto,
} from './dto/audit-log.dto';

@ApiTags('Organizations')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'ORGANIZATION_PERMISSION_DENIED')
@ApiProblemResponse(404, 'ORGANIZATION_NOT_FOUND')
@UseGuards(OrganizationAccessGuard)
@Controller('organizations/:organizationId/audit-logs')
export class OrganizationAuditLogsController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequireOrgPermission(OrgPermission.ReadAuditLogs)
  @ApiOperation({
    summary: "List an organization's audit log",
    description:
      'Requires `audit_logs:read` (owner and admin). Who changed members, roles, API keys and wallets, newest first.',
  })
  @ApiOkResponse({ type: AuditLogsPageDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(400, 'INVALID_CURSOR')
  async list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: ListAuditLogsQueryDto,
  ): Promise<AuditLogsPageDto> {
    const { limit, cursor, ...filter } = query;
    const page = await this.audit.list(
      { ...filter, organizationId },
      { limit, before: cursor ? decodeCursor(cursor) : undefined },
    );
    return {
      data: page.entries.map((entry) => AuditLogResponseDto.from(entry)),
      nextCursor: page.next ? encodeCursor(page.next) : null,
    };
  }
}
