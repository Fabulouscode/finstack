import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Organization } from '../organizations/organization.entity';

export type ProposalKind = 'payout';

export type ProposalStatus =
  'pending' | 'rejected' | 'executed' | 'failed' | 'expired';

export interface PayoutProposalParams {
  destinationId: string;
  /** Minor units, as a string (bigint-safe). */
  amount: string;
  walletId?: string;
  narration?: string;
}

/**
 * An action an agent (or anyone with `proposals:create`) suggests, which does
 * nothing until a person with `proposals:decide` approves it. Approval runs
 * the action through the normal path, idempotent by the proposal's id, so a
 * proposal can execute at most once.
 */
@Entity({ name: 'action_proposals' })
@Check('chk_action_proposals_kind', `"kind" IN ('payout')`)
@Check(
  'chk_action_proposals_status',
  `"status" IN ('pending', 'rejected', 'executed', 'failed', 'expired')`,
)
@Check(
  'chk_action_proposals_decided',
  `("status" = 'pending') = ("decided_at" IS NULL)`,
)
@Index('idx_action_proposals_org_status', [
  'organizationId',
  'status',
  'createdAt',
])
export class ActionProposal {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_action_proposals',
  })
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_action_proposals_organization',
  })
  organization?: Organization;

  @Column({ type: 'varchar', length: 20 })
  kind: ProposalKind;

  @Column({ type: 'jsonb' })
  params: PayoutProposalParams;

  /** One line for the approver, e.g. "Pay Ada $250 for October design work". */
  @Column({ type: 'varchar', length: 300 })
  summary: string;

  /** Why the proposer thinks this is right. */
  @Column({ type: 'text' })
  reasoning: string;

  /** What the proposer looked at: record ids, figures, links. */
  @Column({ type: 'jsonb', nullable: true })
  evidence: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: ProposalStatus;

  /** Set when an API key (e.g. an AI agent) proposed it. */
  @Column({ type: 'uuid', nullable: true })
  proposedByApiKeyId: string | null;

  /** Set when a person proposed it. */
  @Column({ type: 'uuid', nullable: true })
  proposedByUserId: string | null;

  @Column({ type: 'uuid', nullable: true })
  decidedByUserId: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  decisionNote: string | null;

  /** Executed: what was created, e.g. { payoutId }. */
  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  failureReason: string | null;

  /** A pending proposal can't be approved after this. */
  @Column({ type: 'timestamptz', precision: 3 })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
