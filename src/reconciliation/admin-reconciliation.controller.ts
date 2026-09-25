import { InjectQueue } from '@nestjs/bullmq';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Queue } from 'bullmq';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { QueueName } from '../queues/queue-names';
import { UserRole } from '../users/user.entity';
import {
  ListReconciliationItemsQueryDto,
  ListReconciliationRunsQueryDto,
  ReconciliationItemResponseDto,
  ReconciliationItemsPageDto,
  ReconciliationRunResponseDto,
  ResolveReconciliationItemRequestDto,
  StartReconciliationRequestDto,
} from './dto/reconciliation.dto';
import { RECONCILIATION_JOB } from './reconciliation-jobs';
import { ReconciliationTrigger } from './reconciliation-run.entity';
import { InvalidReconciliationPeriodException } from './reconciliation.errors';
import { ReconciliationService } from './reconciliation.service';

const MAX_PERIOD_MS = 31 * 24 * 60 * 60 * 1000;

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@Roles(UserRole.Admin)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'FORBIDDEN: admin role required')
@Controller('admin/reconciliation')
export class AdminReconciliationController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    @InjectQueue(QueueName.Maintenance) private readonly queue: Queue,
  ) {}

  @Post('runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Start a reconciliation run',
    description:
      "Compares FinStack's payments and payouts with the provider's records for the period (or, without a provider, checks the ledger). " +
      'Runs in the background; poll the run. Late webhooks are settled automatically; other differences become items to resolve.',
  })
  @ApiAcceptedResponse({ type: ReconciliationRunResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(
    422,
    'INVALID_RECONCILIATION_PERIOD | PROVIDER_CANNOT_RECONCILE | UNKNOWN_PAYMENT_PROVIDER',
  )
  async start(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() body: StartReconciliationRequestDto,
  ): Promise<ReconciliationRunResponseDto> {
    const span = body.to.getTime() - body.from.getTime();
    if (span <= 0 || span > MAX_PERIOD_MS) {
      throw new InvalidReconciliationPeriodException(
        '`to` must be after `from`, by at most 31 days',
      );
    }
    if (body.to.getTime() > Date.now()) {
      throw new InvalidReconciliationPeriodException(
        'The period cannot end in the future',
      );
    }
    const run = await this.reconciliation.createRun({
      provider: body.provider ?? null,
      range: { from: body.from, to: body.to },
      trigger: ReconciliationTrigger.Manual,
      requestedByUserId: admin.id,
    });
    // Manual runs are never deduplicated, so a run always exists here.
    const created = run as NonNullable<typeof run>;
    await this.queue.add(
      RECONCILIATION_JOB,
      { runId: created.id },
      { jobId: `reconciliation-${created.id}` },
    );
    return ReconciliationRunResponseDto.from(created);
  }

  @Get('runs')
  @ApiOperation({
    summary: 'List reconciliation runs',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: [ReconciliationRunResponseDto] })
  async listRuns(
    @Query() query: ListReconciliationRunsQueryDto,
  ): Promise<ReconciliationRunResponseDto[]> {
    return (await this.reconciliation.listRuns(query.limit)).map((run) =>
      ReconciliationRunResponseDto.from(run),
    );
  }

  @Get('runs/:runId')
  @ApiOperation({ summary: 'Get a reconciliation run' })
  @ApiOkResponse({ type: ReconciliationRunResponseDto })
  @ApiProblemResponse(404, 'RECONCILIATION_RUN_NOT_FOUND')
  async getRun(
    @Param('runId', ParseUUIDPipe) runId: string,
  ): Promise<ReconciliationRunResponseDto> {
    return ReconciliationRunResponseDto.from(
      await this.reconciliation.getRun(runId),
    );
  }

  @Get('items')
  @ApiOperation({
    summary: 'List reconciliation items',
    description:
      'Differences found by runs, newest first. Filter `status=open` for the work queue.',
  })
  @ApiOkResponse({ type: ReconciliationItemsPageDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(400, 'INVALID_CURSOR')
  async listItems(
    @Query() query: ListReconciliationItemsQueryDto,
  ): Promise<ReconciliationItemsPageDto> {
    const page = await this.reconciliation.listItems(
      { status: query.status, runId: query.runId },
      {
        limit: query.limit,
        before: query.cursor ? decodeCursor(query.cursor) : undefined,
      },
    );
    return {
      data: page.items.map((item) => ReconciliationItemResponseDto.from(item)),
      nextCursor: page.next ? encodeCursor(page.next) : null,
    };
  }

  @Post('items/:itemId/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve a reconciliation item',
    description:
      'Records what was done about a difference (e.g. a manual adjustment). Audited. Fixing the money itself is a separate, deliberate action.',
  })
  @ApiOkResponse({ type: ReconciliationItemResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(404, 'RECONCILIATION_ITEM_NOT_FOUND')
  @ApiProblemResponse(409, 'RECONCILIATION_ITEM_NOT_OPEN')
  async resolve(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: ResolveReconciliationItemRequestDto,
  ): Promise<ReconciliationItemResponseDto> {
    return ReconciliationItemResponseDto.from(
      await this.reconciliation.resolve(itemId, admin.id, body.note),
    );
  }
}
