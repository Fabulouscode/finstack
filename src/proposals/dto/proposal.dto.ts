import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MAX_API_AMOUNT, toApiAmount } from '../../common/money/money';
import { ActionProposal } from '../action-proposal.entity';
import type { ProposalKind, ProposalStatus } from '../action-proposal.entity';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const PROPOSAL_STATUSES: ProposalStatus[] = [
  'pending',
  'rejected',
  'executed',
  'failed',
  'expired',
];

export class CreateProposalRequestDto {
  @ApiProperty({ enum: ['payout'], description: 'What to do if approved' })
  @IsIn(['payout'])
  kind: ProposalKind;

  @ApiProperty({ format: 'uuid', description: 'Payout: a saved destination' })
  @IsUUID()
  destinationId: string;

  @ApiProperty({ description: 'Minor units', example: 25000 })
  @IsInt()
  @IsPositive()
  @Max(MAX_API_AMOUNT)
  amount: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  walletId?: string;

  @ApiPropertyOptional({ maxLength: 100, example: 'October design work' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  narration?: string;

  @ApiProperty({
    maxLength: 300,
    example: 'Pay Ada Lovelace $250 for October design work',
    description: 'One line the approver reads first',
  })
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  summary: string;

  @ApiProperty({
    maxLength: 4000,
    description: 'Why this is the right action',
  })
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(4000)
  reasoning: string;

  @ApiPropertyOptional({
    description: 'What was checked: record ids, figures, links',
    example: { invoice: 'INV-104', lastPaid: '2026-09-30' },
  })
  @IsOptional()
  @IsObject()
  evidence?: Record<string, unknown>;
}

export class DecideProposalRequestDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListProposalsQueryDto {
  @ApiPropertyOptional({ enum: PROPOSAL_STATUSES })
  @IsOptional()
  @IsIn(PROPOSAL_STATUSES)
  status?: ProposalStatus;
}

export class ProposalResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ['payout'] }) kind: ProposalKind;
  @ApiProperty({ enum: PROPOSAL_STATUSES }) status: ProposalStatus;
  @ApiProperty({ format: 'uuid' }) destinationId: string;
  @ApiProperty({ description: 'Minor units' }) amount: number;
  @ApiProperty({ type: String, nullable: true }) walletId: string | null;
  @ApiProperty({ type: String, nullable: true }) narration: string | null;
  @ApiProperty() summary: string;
  @ApiProperty() reasoning: string;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  evidence: Record<string, unknown> | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Set when an API key (e.g. an AI agent) proposed it',
  })
  proposedByApiKeyId: string | null;
  @ApiProperty({ type: String, nullable: true })
  proposedByUserId: string | null;
  @ApiProperty({ type: String, nullable: true })
  decidedByUserId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) decisionNote: string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { payoutId: '…', reference: 'pyt_…' },
  })
  result: Record<string, unknown> | null;
  @ApiProperty({ type: String, nullable: true }) failureReason: string | null;
  @ApiProperty({ format: 'date-time' }) expiresAt: Date;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;

  static from(proposal: ActionProposal): ProposalResponseDto {
    return {
      id: proposal.id,
      kind: proposal.kind,
      status: proposal.status,
      destinationId: proposal.params.destinationId,
      amount: toApiAmount(BigInt(proposal.params.amount)),
      walletId: proposal.params.walletId ?? null,
      narration: proposal.params.narration ?? null,
      summary: proposal.summary,
      reasoning: proposal.reasoning,
      evidence: proposal.evidence,
      proposedByApiKeyId: proposal.proposedByApiKeyId,
      proposedByUserId: proposal.proposedByUserId,
      decidedByUserId: proposal.decidedByUserId,
      decidedAt: proposal.decidedAt,
      decisionNote: proposal.decisionNote,
      result: proposal.result,
      failureReason: proposal.failureReason,
      expiresAt: proposal.expiresAt,
      createdAt: proposal.createdAt,
    };
  }
}
