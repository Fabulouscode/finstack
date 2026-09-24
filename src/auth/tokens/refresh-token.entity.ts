import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/user.entity';

/**
 * One row per issued refresh token. The token itself is never stored, only
 * its SHA-256 hash. Tokens issued from the same login share a `familyId`, so
 * reuse of a rotated token can revoke the whole session.
 */
@Entity({ name: 'refresh_tokens' })
@Index('idx_refresh_tokens_user_id', ['userId'])
@Index('idx_refresh_tokens_family_id', ['familyId'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_refresh_tokens',
  })
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_refresh_tokens_user',
  })
  user?: User;

  @Column({ type: 'uuid' })
  familyId: string;

  @Index('uq_refresh_tokens_token_hash', { unique: true })
  @Column({ type: 'char', length: 64 })
  tokenHash: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  replacedById: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
