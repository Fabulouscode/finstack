import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import { decodeCursor, encodeCursor } from '../common/pagination/cursor';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { RequireOrgPermission } from '../organizations/guards/organization-access';
import { OrganizationAccessGuard } from '../organizations/guards/organization-access.guard';
import { OrgPermission } from '../organizations/organization-permissions';
import {
  CreateWebhookEndpointRequestDto,
  ListWebhookDeliveriesQueryDto,
  RotateWebhookSecretRequestDto,
  UpdateWebhookEndpointRequestDto,
  WebhookDeliveriesPageDto,
  WebhookDeliveryResponseDto,
  WebhookEndpointResponseDto,
  WebhookEndpointWithSecretResponseDto,
} from './dto/webhook-endpoint.dto';
import { OutboundWebhooksService } from './outbound-webhooks.service';

/**
 * Where an organization receives signed event callbacks. All routes need
 * `webhooks:manage` (owner, admin).
 */
@ApiTags('Organization webhooks')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'ORGANIZATION_PERMISSION_DENIED')
@ApiProblemResponse(404, 'ORGANIZATION_NOT_FOUND | WEBHOOK_ENDPOINT_NOT_FOUND')
@UseGuards(OrganizationAccessGuard)
@Controller('organizations/:organizationId/webhook-endpoints')
export class WebhookEndpointsController {
  constructor(private readonly webhooks: OutboundWebhooksService) {}

  @Post()
  @RequireOrgPermission(OrgPermission.ManageWebhooks)
  @ApiOperation({
    summary: 'Register a webhook endpoint',
    description:
      'Returns the signing secret once. Each request carries `FinStack-Signature: t=<unix>,v1=<hex>`: ' +
      'HMAC-SHA256 of `<t>.<raw body>` with the secret. Verify it, reject old timestamps, and dedupe on the event `id`.',
  })
  @ApiCreatedResponse({ type: WebhookEndpointWithSecretResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(
    422,
    'WEBHOOK_URL_NOT_ALLOWED: not https, or a private/internal address',
  )
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: CreateWebhookEndpointRequestDto,
  ): Promise<WebhookEndpointWithSecretResponseDto> {
    const { endpoint, secret } = await this.webhooks.create(
      organizationId,
      body,
    );
    return { ...WebhookEndpointResponseDto.from(endpoint), secret };
  }

  @Get()
  @RequireOrgPermission(OrgPermission.ManageWebhooks)
  @ApiOperation({ summary: 'List webhook endpoints' })
  @ApiOkResponse({ type: [WebhookEndpointResponseDto] })
  async list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<WebhookEndpointResponseDto[]> {
    return (await this.webhooks.list(organizationId)).map((endpoint) =>
      WebhookEndpointResponseDto.from(endpoint),
    );
  }

  @Get(':endpointId')
  @RequireOrgPermission(OrgPermission.ManageWebhooks)
  @ApiOperation({ summary: 'Get a webhook endpoint' })
  @ApiOkResponse({ type: WebhookEndpointResponseDto })
  async get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
  ): Promise<WebhookEndpointResponseDto> {
    return WebhookEndpointResponseDto.from(
      await this.webhooks.get(organizationId, endpointId),
    );
  }

  @Patch(':endpointId')
  @RequireOrgPermission(OrgPermission.ManageWebhooks)
  @ApiOperation({
    summary: 'Update a webhook endpoint',
    description: 'Change the URL or events, or disable/re-enable it.',
  })
  @ApiOkResponse({ type: WebhookEndpointResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(422, 'WEBHOOK_URL_NOT_ALLOWED')
  async update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
    @Body() body: UpdateWebhookEndpointRequestDto,
  ): Promise<WebhookEndpointResponseDto> {
    return WebhookEndpointResponseDto.from(
      await this.webhooks.update(organizationId, endpointId, body),
    );
  }

  @Delete(':endpointId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireOrgPermission(OrgPermission.ManageWebhooks)
  @ApiOperation({ summary: 'Delete a webhook endpoint' })
  @ApiNoContentResponse()
  async remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
  ): Promise<void> {
    await this.webhooks.remove(organizationId, endpointId);
  }

  @Post(':endpointId/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @RequireOrgPermission(OrgPermission.ManageWebhooks)
  @ApiOperation({
    summary: 'Rotate the signing secret',
    description:
      'Returns the new secret once. During the grace period requests carry signatures from both secrets.',
  })
  @ApiOkResponse({ type: WebhookEndpointWithSecretResponseDto })
  @ApiValidationProblemResponse()
  async rotate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
    @Body() body: RotateWebhookSecretRequestDto,
  ): Promise<WebhookEndpointWithSecretResponseDto> {
    const { endpoint, secret } = await this.webhooks.rotateSecret(
      organizationId,
      endpointId,
      body.graceHours,
    );
    return { ...WebhookEndpointResponseDto.from(endpoint), secret };
  }

  @Post(':endpointId/test')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireOrgPermission(OrgPermission.ManageWebhooks)
  @ApiOperation({
    summary: 'Send a test event',
    description:
      'Queues a `webhook.test` event to the endpoint; check its delivery.',
  })
  @ApiOkResponse({ type: WebhookDeliveryResponseDto })
  async test(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
  ): Promise<WebhookDeliveryResponseDto> {
    return WebhookDeliveryResponseDto.from(
      await this.webhooks.sendTest(organizationId, endpointId),
    );
  }

  @Get(':endpointId/deliveries')
  @RequireOrgPermission(OrgPermission.ManageWebhooks)
  @ApiOperation({
    summary: 'List deliveries',
    description:
      'Newest first, with the response status and error of the last attempt.',
  })
  @ApiOkResponse({ type: WebhookDeliveriesPageDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(400, 'INVALID_CURSOR')
  async deliveries(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
    @Query() query: ListWebhookDeliveriesQueryDto,
  ): Promise<WebhookDeliveriesPageDto> {
    const page = await this.webhooks.listDeliveries(
      organizationId,
      endpointId,
      {
        status: query.status,
        limit: query.limit,
        before: query.cursor ? decodeCursor(query.cursor) : undefined,
      },
    );
    return {
      data: page.deliveries.map((d) => WebhookDeliveryResponseDto.from(d)),
      nextCursor: page.next ? encodeCursor(page.next) : null,
    };
  }

  @Post(':endpointId/deliveries/:deliveryId/redeliver')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireOrgPermission(OrgPermission.ManageWebhooks)
  @ApiOperation({
    summary: 'Send a delivery again',
    description: 'Same event id and body, freshly signed.',
  })
  @ApiOkResponse({ type: WebhookDeliveryResponseDto })
  @ApiProblemResponse(404, 'WEBHOOK_DELIVERY_NOT_FOUND')
  async redeliver(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
  ): Promise<WebhookDeliveryResponseDto> {
    return WebhookDeliveryResponseDto.from(
      await this.webhooks.redeliver(organizationId, endpointId, deliveryId),
    );
  }
}
