import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/http/app.exception';
import { organizationOwner } from '../common/owner/owner';
import { PayoutDestinationsService } from '../payouts/payout-destinations.service';
import { PayoutsService } from '../payouts/payouts.service';
import {
  ActionProposal,
  ProposalKind,
  ProposalStatus,
} from './action-proposal.entity';
import {
  ProposalAlreadyDecidedException,
  ProposalExpiredException,
  ProposalNotFoundException,
} from './proposals.errors';

/** How long a proposal can wait for a decision. */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface Proposer {
  userId?: string;
  apiKeyId?: string;
}

export interface NewPayoutProposal {
  kind: ProposalKind;
  destinationId: string;
  amount: bigint;
  walletId?: string;
  narration?: string;
  summary: string;
  reasoning: string;
  evidence?: Record<string, unknown>;
}

@Injectable()
export class ProposalsService {
  private readonly logger = new Logger(ProposalsService.name);

  constructor(
    @InjectRepository(ActionProposal)
    private readonly proposals: Repository<ActionProposal>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly payouts: PayoutsService,
    private readonly destinations: PayoutDestinationsService,
    private readonly audit: AuditService,
  ) {}

  /** Records a suggestion. Nothing moves until a person approves it. */
  async propose(
    organizationId: string,
    proposer: Proposer,
    input: NewPayoutProposal,
  ): Promise<ActionProposal> {
    // Fail now, not at approval, if the destination isn't this organization's.
    await this.destinations.getActive(
      organizationOwner(organizationId),
      input.destinationId,
    );

    return this.dataSource.transaction(async (manager) => {
      const proposal = await manager.save(
        manager.create(ActionProposal, {
          organizationId,
          kind: input.kind,
          params: {
            destinationId: input.destinationId,
            amount: input.amount.toString(),
            ...(input.walletId ? { walletId: input.walletId } : {}),
            ...(input.narration ? { narration: input.narration } : {}),
          },
          summary: input.summary,
          reasoning: input.reasoning,
          evidence: input.evidence ?? null,
          status: 'pending',
          proposedByApiKeyId: proposer.apiKeyId ?? null,
          proposedByUserId: proposer.userId ?? null,
          decidedByUserId: null,
          decidedAt: null,
          decisionNote: null,
          result: null,
          failureReason: null,
          expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
        }),
      );
      await this.audit.record(manager, {
        action: AuditAction.ProposalCreated,
        organizationId,
        targetType: 'action_proposal',
        targetId: proposal.id,
        metadata: {
          kind: proposal.kind,
          summary: proposal.summary,
          ...proposal.params,
        },
      });
      return proposal;
    });
  }

  list(
    organizationId: string,
    status?: ProposalStatus,
  ): Promise<ActionProposal[]> {
    return this.proposals.find({
      where: { organizationId, ...(status ? { status } : {}) },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  async get(organizationId: string, id: string): Promise<ActionProposal> {
    const proposal = await this.proposals.findOneBy({ id, organizationId });
    if (!proposal) throw new ProposalNotFoundException();
    return proposal;
  }

  /**
   * Runs the proposed action. The proposal row is locked while it runs, so
   * two approvers can't both execute it, and the payout's Idempotency-Key is
   * the proposal's id, so a retry after a crash returns the same payout.
   */
  async approve(
    organizationId: string,
    id: string,
    userId: string,
    note?: string,
  ): Promise<ActionProposal> {
    await this.expireIfDue(organizationId, id);

    return this.dataSource.transaction(async (manager) => {
      const proposal = await this.lockPending(manager, organizationId, id);

      try {
        const view = await this.payouts.request(
          organizationOwner(organizationId),
          {
            destinationId: proposal.params.destinationId,
            amount: BigInt(proposal.params.amount),
            walletId: proposal.params.walletId,
            narration: proposal.params.narration,
          },
          `proposal:${proposal.id}`,
        );
        proposal.status = 'executed';
        proposal.result = {
          payoutId: view.payout.id,
          reference: view.payout.reference,
        };
      } catch (error) {
        // A rejection (e.g. insufficient balance) is final; an outage isn't,
        // so the proposal stays pending and can be approved again.
        if (!(error instanceof AppException) || error.getStatus() >= 500) {
          throw error;
        }
        proposal.status = 'failed';
        proposal.failureReason = error.detail.slice(0, 500);
        this.logger.warn(`Proposal ${proposal.id} failed: ${error.detail}`);
      }

      proposal.decidedByUserId = userId;
      proposal.decidedAt = new Date();
      proposal.decisionNote = note ?? null;
      await manager.save(proposal);
      await this.audit.record(manager, {
        action: AuditAction.ProposalApproved,
        organizationId,
        targetType: 'action_proposal',
        targetId: proposal.id,
        metadata: {
          outcome: proposal.status,
          ...(proposal.result ?? {}),
          ...(proposal.failureReason
            ? { failureReason: proposal.failureReason }
            : {}),
        },
      });
      return proposal;
    });
  }

  async reject(
    organizationId: string,
    id: string,
    userId: string,
    note?: string,
  ): Promise<ActionProposal> {
    return this.dataSource.transaction(async (manager) => {
      const proposal = await this.lockPending(manager, organizationId, id);
      proposal.status = 'rejected';
      proposal.decidedByUserId = userId;
      proposal.decidedAt = new Date();
      proposal.decisionNote = note ?? null;
      await manager.save(proposal);
      await this.audit.record(manager, {
        action: AuditAction.ProposalRejected,
        organizationId,
        targetType: 'action_proposal',
        targetId: proposal.id,
        metadata: note ? { note } : {},
      });
      return proposal;
    });
  }

  private async lockPending(
    manager: DataSource['manager'],
    organizationId: string,
    id: string,
  ): Promise<ActionProposal> {
    const proposal = await manager.findOne(ActionProposal, {
      where: { id, organizationId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!proposal) throw new ProposalNotFoundException();
    if (proposal.status !== 'pending') {
      throw new ProposalAlreadyDecidedException(proposal.status);
    }
    return proposal;
  }

  /** Marks a stale proposal expired (its own commit), then refuses it. */
  private async expireIfDue(organizationId: string, id: string): Promise<void> {
    const expired = await this.proposals
      .createQueryBuilder()
      .update(ActionProposal)
      .set({ status: 'expired', decidedAt: () => 'now()' })
      .where('id = :id AND organization_id = :organizationId', {
        id,
        organizationId,
      })
      .andWhere("status = 'pending' AND expires_at <= now()")
      .execute();
    if (expired.affected) throw new ProposalExpiredException();
  }
}
