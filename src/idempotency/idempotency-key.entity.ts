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
import { User } from '../users/user.entity';

export enum IdempotencyKeyStatus {
  Processing = 'processing',
  Completed = 'completed',
}

/**
 * One row per (user, Idempotency-Key). Stores a fingerprint of the request
 * and, once finished, the response to replay for retries.
 */
@Entity({ name: 'idempotency_keys' })
@Index('uq_idempotency_keys_user_key', ['userId', 'key'], { unique: true })
@Index('idx_idempotency_keys_expires_at', ['expiresAt'])
@Check('chk_idempotency_keys_status', `"status" IN ('processing', 'completed')`)
@Check(
  'chk_idempotency_keys_response_when_completed',
  `("status" = 'completed') = ("response_status" IS NOT NULL)`,
)
export class IdempotencyKey {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_idempotency_keys',
  })
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_idempotency_keys_user',
  })
  user?: User;

  @Column({ type: 'varchar', length: 255 })
  key: string;

  @Column({ type: 'varchar', length: 10 })
  method: string;

  @Column({ type: 'varchar', length: 500 })
  path: string;

  /** SHA-256 of method, path and canonical JSON body. */
  @Column({ type: 'char', length: 64 })
  requestHash: string;

  @Column({ type: 'varchar', length: 20 })
  status: IdempotencyKeyStatus;

  @Column({ type: 'integer', nullable: true })
  responseStatus: number | null;

  /** The serialised JSON response (null for empty bodies). */
  @Column({ type: 'jsonb', nullable: true })
  responseBody: object | null;

  /** When the current attempt started; used to take over stale locks. */
  @Column({ type: 'timestamptz', precision: 3 })
  lockedAt: Date;

  @Column({ type: 'timestamptz', precision: 3 })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  completedAt: Date | null;
}
