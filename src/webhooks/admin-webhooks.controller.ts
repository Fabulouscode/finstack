import { InjectQueue } from '@nestjs/bullmq';
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Queue } from 'bullmq';
import { Roles } from '../auth/decorators/roles.decorator';
import { ApiProblemResponse } from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { QueueName } from '../queues/queue-names';
import { UserRole } from '../users/user.entity';
import { WebhookEvent, WebhookEventStatus } from './webhook-event.entity';
import { WebhooksService } from './webhooks.service';

export class ListWebhookEventsQueryDto {
  @ApiPropertyOptional({
    enum: WebhookEventStatus,
    example: WebhookEventStatus.Failed,
  })
  @IsOptional()
  @IsEnum(WebhookEventStatus)
  status?: WebhookEventStatus;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}

export class WebhookEventDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'mock' }) provider: string;
  @ApiProperty({ example: 'evt_4f9a2c1e7b3d5a8c' }) eventId: string;
  @ApiProperty({ example: 'payment.succeeded' }) type: string;
  @ApiProperty({ enum: WebhookEventStatus }) status: WebhookEventStatus;
  @ApiProperty({ nullable: true, example: 'credited' }) outcome: string | null;
  @ApiProperty({ example: 1 }) attempts: number;
  @ApiProperty({ nullable: true }) lastError: string | null;
  @ApiProperty({ format: 'date-time' }) receivedAt: Date;
  @ApiProperty({ format: 'date-time', nullable: true })
  processedAt: Date | null;

  static from(event: WebhookEvent): WebhookEventDto {
    return {
      id: event.id,
      provider: event.provider,
      eventId: event.eventId,
      type: event.type,
      status: event.status,
      outcome: event.outcome,
      attempts: event.attempts,
      lastError: event.lastError,
      receivedAt: event.receivedAt,
      processedAt: event.processedAt,
    };
  }
}

export class QueueStatsDto {
  @ApiProperty({ example: 'webhooks' }) queue: string;
  @ApiProperty({ example: 0 }) waiting: number;
  @ApiProperty({ example: 0 }) active: number;
  @ApiProperty({ example: 1 }) delayed: number;
  @ApiProperty({ example: 0 }) failed: number;
  @ApiProperty({ example: 42 }) completed: number;
}

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@Roles(UserRole.Admin)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'FORBIDDEN: admin role required')
@Controller('admin')
export class AdminWebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    @InjectQueue(QueueName.Webhooks) private readonly webhooksQueue: Queue,
    @InjectQueue(QueueName.DomainEvents)
    private readonly domainEventsQueue: Queue,
    @InjectQueue(QueueName.Maintenance)
    private readonly maintenanceQueue: Queue,
  ) {}

  @Get('webhook-events')
  @ApiOperation({
    summary: 'List webhook events',
    description:
      'Filter by `status=failed` to see dead-lettered events awaiting replay.',
  })
  @ApiOkResponse({ type: [WebhookEventDto] })
  async list(
    @Query() query: ListWebhookEventsQueryDto,
  ): Promise<WebhookEventDto[]> {
    return (await this.webhooks.list(query)).map((event) =>
      WebhookEventDto.from(event),
    );
  }

  @Post('webhook-events/:id/replay')
  @ApiOperation({
    summary: 'Replay a failed or ignored webhook event',
    description:
      'Schedules the event for processing again. Settlement is idempotent: replays never double-credit.',
  })
  @ApiOkResponse({ type: WebhookEventDto })
  @ApiProblemResponse(404, 'WEBHOOK_EVENT_NOT_FOUND')
  @ApiProblemResponse(
    409,
    'WEBHOOK_EVENT_NOT_REPLAYABLE: only failed or ignored events',
  )
  async replay(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WebhookEventDto> {
    return WebhookEventDto.from(await this.webhooks.replay(id));
  }

  @Get('queues')
  @ApiOperation({ summary: 'Queue depths and failure counts' })
  @ApiOkResponse({ type: [QueueStatsDto] })
  async queues(): Promise<QueueStatsDto[]> {
    return Promise.all(
      [this.webhooksQueue, this.domainEventsQueue, this.maintenanceQueue].map(
        async (queue) => {
          const counts = await queue.getJobCounts(
            'waiting',
            'active',
            'delayed',
            'failed',
            'completed',
          );
          return {
            queue: queue.name,
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
            completed: counts.completed ?? 0,
          };
        },
      ),
    );
  }
}
