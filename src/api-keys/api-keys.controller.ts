import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
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
import type { OrganizationRequest } from '../organizations/guards/organization-access';
import { RequireOrgPermission } from '../organizations/guards/organization-access';
import { OrganizationAccessGuard } from '../organizations/guards/organization-access.guard';
import {
  OrgPermission,
  OrgRole,
} from '../organizations/organization-permissions';
import { ApiKeysService } from './api-keys.service';
import {
  ApiKeyResponseDto,
  CreateApiKeyRequestDto,
  CreatedApiKeyResponseDto,
} from './dto/api-key.dto';

/** Key management is for signed-in members only; keys can't manage keys. */
@ApiTags('Organizations')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED | API_KEY_NOT_ALLOWED')
@ApiProblemResponse(
  403,
  'ORGANIZATION_PERMISSION_DENIED: requires api_keys:manage',
)
@UseGuards(OrganizationAccessGuard)
@Controller('organizations/:organizationId/api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Post()
  @RequireOrgPermission(OrgPermission.ManageApiKeys)
  @ApiOperation({
    summary: 'Create an API key',
    description:
      'Returns the secret once. Scopes are limited to what your role allows, and keys cannot manage members, keys or the organization.',
  })
  @ApiCreatedResponse({ type: CreatedApiKeyResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(422, 'API_KEY_SCOPE_NOT_GRANTABLE')
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: OrganizationRequest,
    @Body() body: CreateApiKeyRequestDto,
  ): Promise<CreatedApiKeyResponseDto> {
    const { apiKey, secret } = await this.apiKeys.create({
      organizationId,
      creatorId: user.id,
      creatorRole: request.organizationAccess?.role ?? OrgRole.Viewer,
      name: body.name,
      scopes: body.scopes,
      expiresAt: body.expiresAt,
    });
    return { ...ApiKeyResponseDto.from(apiKey), key: secret };
  }

  @Get()
  @RequireOrgPermission(OrgPermission.ManageApiKeys)
  @ApiOperation({
    summary: 'List API keys',
    description: 'Secrets are never returned again.',
  })
  @ApiOkResponse({ type: [ApiKeyResponseDto] })
  async list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<ApiKeyResponseDto[]> {
    return (await this.apiKeys.list(organizationId)).map((key) =>
      ApiKeyResponseDto.from(key),
    );
  }

  @Delete(':apiKeyId')
  @RequireOrgPermission(OrgPermission.ManageApiKeys)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke an API key',
    description: 'Takes effect immediately.',
  })
  @ApiNoContentResponse()
  @ApiProblemResponse(404, 'API_KEY_NOT_FOUND')
  async revoke(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('apiKeyId', ParseUUIDPipe) apiKeyId: string,
  ): Promise<void> {
    await this.apiKeys.revoke(organizationId, apiKeyId);
  }
}
