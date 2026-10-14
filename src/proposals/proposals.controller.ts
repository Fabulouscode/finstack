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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { AllowApiKey } from '../api-keys/api-key-principal';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { toMinorUnits } from '../common/money/money';
import { RequestContext } from '../common/request-context/request-context';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME, API_KEY_SCHEME } from '../docs/swagger';
import { RequireOrgPermission } from '../organizations/guards/organization-access';
import { OrganizationAccessGuard } from '../organizations/guards/organization-access.guard';
import { OrgPermission } from '../organizations/organization-permissions';
import {
  CreateProposalRequestDto,
  DecideProposalRequestDto,
  ListProposalsQueryDto,
  ProposalResponseDto,
} from './dto/proposal.dto';
import { Proposer, ProposalsService } from './proposals.service';

const DECISION_PROBLEMS =
  'PROPOSAL_ALREADY_DECIDED | PROPOSAL_EXPIRED: it can no longer be decided';

/**
 * Proposed actions for an organization. Anyone with `proposals:create`,
 * including an API key used by an AI agent, can suggest an action; only a
 * person with `proposals:decide` can approve or reject it. The decision
 * routes don't accept API keys, so no key can approve its own proposal.
 */
@ApiTags('Proposals')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED: missing or invalid credentials')
@ApiProblemResponse(403, 'FORBIDDEN: your role or API key lacks the permission')
@UseGuards(OrganizationAccessGuard)
@Controller('organizations/:organizationId/proposals')
export class ProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  @Post()
  @AllowApiKey()
  @ApiSecurity(API_KEY_SCHEME)
  @RequireOrgPermission(OrgPermission.ProposeActions)
  @ApiOperation({
    summary: 'Propose an action (e.g. a payout) for a person to approve',
    description:
      'Requires `proposals:create`. Nothing happens until someone with `proposals:decide` approves it.',
  })
  @ApiCreatedResponse({ type: ProposalResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(404, 'PAYOUT_DESTINATION_NOT_FOUND')
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: CreateProposalRequestDto,
  ): Promise<ProposalResponseDto> {
    const actor = RequestContext.actor();
    const proposer: Proposer =
      actor.type === 'api_key'
        ? { apiKeyId: actor.id }
        : actor.type === 'user'
          ? { userId: actor.id }
          : {};
    return ProposalResponseDto.from(
      await this.proposals.propose(organizationId, proposer, {
        kind: body.kind,
        destinationId: body.destinationId,
        amount: toMinorUnits(body.amount),
        walletId: body.walletId,
        narration: body.narration,
        summary: body.summary,
        reasoning: body.reasoning,
        evidence: body.evidence,
      }),
    );
  }

  @Get()
  @AllowApiKey()
  @ApiSecurity(API_KEY_SCHEME)
  @RequireOrgPermission(OrgPermission.ProposeActions)
  @ApiOperation({ summary: 'List proposals, newest first (100 at most)' })
  @ApiOkResponse({ type: [ProposalResponseDto] })
  async list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: ListProposalsQueryDto,
  ): Promise<ProposalResponseDto[]> {
    return (await this.proposals.list(organizationId, query.status)).map(
      (proposal) => ProposalResponseDto.from(proposal),
    );
  }

  @Get(':proposalId')
  @AllowApiKey()
  @ApiSecurity(API_KEY_SCHEME)
  @RequireOrgPermission(OrgPermission.ProposeActions)
  @ApiOkResponse({ type: ProposalResponseDto })
  @ApiProblemResponse(404, 'PROPOSAL_NOT_FOUND')
  async get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
  ): Promise<ProposalResponseDto> {
    return ProposalResponseDto.from(
      await this.proposals.get(organizationId, proposalId),
    );
  }

  @Post(':proposalId/approve')
  @HttpCode(HttpStatus.OK)
  @RequireOrgPermission(OrgPermission.DecideProposals)
  @ApiOperation({
    summary: 'Approve a proposal, which runs it (people only, not API keys)',
    description:
      'Requires `proposals:decide`. A rejected action (e.g. insufficient balance) marks the proposal `failed`.',
  })
  @ApiOkResponse({ type: ProposalResponseDto })
  @ApiProblemResponse(404, 'PROPOSAL_NOT_FOUND')
  @ApiProblemResponse(409, DECISION_PROBLEMS)
  async approve(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DecideProposalRequestDto,
  ): Promise<ProposalResponseDto> {
    return ProposalResponseDto.from(
      await this.proposals.approve(
        organizationId,
        proposalId,
        user.id,
        body.note,
      ),
    );
  }

  @Post(':proposalId/reject')
  @HttpCode(HttpStatus.OK)
  @RequireOrgPermission(OrgPermission.DecideProposals)
  @ApiOperation({ summary: 'Reject a proposal (people only, not API keys)' })
  @ApiOkResponse({ type: ProposalResponseDto })
  @ApiProblemResponse(404, 'PROPOSAL_NOT_FOUND')
  @ApiProblemResponse(409, DECISION_PROBLEMS)
  async reject(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DecideProposalRequestDto,
  ): Promise<ProposalResponseDto> {
    return ProposalResponseDto.from(
      await this.proposals.reject(
        organizationId,
        proposalId,
        user.id,
        body.note,
      ),
    );
  }
}
