import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../database/transformers';
import { LedgerTransaction } from '../ledger/ledger-transaction.entity';
import { sqlList } from '../ledger/ledger.types';
import { Organization } from '../organizations/organization.entity';
import { User } from '../users/user.entity';
import { Wallet } from '../wallets/wallet.entity';
import { TransactionStatus, TransactionType } from './transaction.types';

/**
 * The business view of a money movement (a transfer, a payment, a refund),
 * linking who and why to the ledger transaction that records how.
 */
@Entity({ name: 'transactions' })
@Check(
  'chk_transactions_type',
  `"type" IN (${sqlList(Object.values(TransactionType))})`,
)
@Check(
  'chk_transactions_status',
  `"status" IN (${sqlList(Object.values(TransactionStatus))})`,
)
@Check('chk_transactions_amount_positive', `"amount" > 0`)
@Check('chk_transactions_currency', `"currency" ~ '^[A-Z]{3}$'`)
// A successful transaction must point at the ledger movement that proves it.
@Check(
  'chk_transactions_successful_has_ledger',
  `"status" NOT IN ('successful', 'reversed') OR "ledger_transaction_id" IS NOT NULL`,
)
// Owned by exactly one user or organization.
@Check(
  'chk_transactions_owner',
  `num_nonnulls("user_id", "organization_id") = 1`,
)
// Domain-level idempotency: one transaction per owner and Idempotency-Key.
@Index('uq_transactions_user_idempotency_key', ['userId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotency_key" IS NOT NULL AND "user_id" IS NOT NULL',
})
@Index(
  'uq_transactions_org_idempotency_key',
  ['organizationId', 'idempotencyKey'],
  {
    unique: true,
    where: '"idempotency_key" IS NOT NULL AND "organization_id" IS NOT NULL',
  },
)
// "My transactions" in both directions, newest first (keyset pagination).
@Index('idx_transactions_user_created_id', ['userId', 'createdAt', 'id'])
@Index('idx_transactions_org_created_id', ['organizationId', 'createdAt', 'id'])
@Index('idx_transactions_counterparty_created_id', [
  'counterpartyUserId',
  'createdAt',
  'id',
])
export class Transaction {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_transactions',
  })
  id: string;

  /** Public, human-quotable reference, e.g. `trx_9f2c4e1a7b3d5c8e6f0a`. */
  @Index('uq_transactions_reference', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  reference: string;

  @Column({ type: 'varchar', length: 20 })
  type: TransactionType;

  @Column({ type: 'varchar', length: 20 })
  status: TransactionStatus;

  /** The user who owns the transaction (null for organization transactions). */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_transactions_user',
  })
  user?: User;

  /** The organization that owns the transaction (null for user transactions). */
  @Column({ type: 'uuid', nullable: true })
  organizationId: string | null;

  @ManyToOne(() => Organization, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_transactions_organization',
  })
  organization?: Organization;

  /** The other party, e.g. the recipient of a transfer. */
  @Column({ type: 'uuid', nullable: true })
  counterpartyUserId: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'counterparty_user_id',
    foreignKeyConstraintName: 'fk_transactions_counterparty_user',
  })
  counterpartyUser?: User;

  @Column({ type: 'uuid', nullable: true })
  sourceWalletId: string | null;

  @ManyToOne(() => Wallet, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'source_wallet_id',
    foreignKeyConstraintName: 'fk_transactions_source_wallet',
  })
  sourceWallet?: Wallet;

  @Column({ type: 'uuid', nullable: true })
  destinationWalletId: string | null;

  @ManyToOne(() => Wallet, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'destination_wallet_id',
    foreignKeyConstraintName: 'fk_transactions_destination_wallet',
  })
  destinationWallet?: Wallet;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'uuid', nullable: true })
  ledgerTransactionId: string | null;

  @ManyToOne(() => LedgerTransaction, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'ledger_transaction_id',
    foreignKeyConstraintName: 'fk_transactions_ledger_transaction',
  })
  ledgerTransaction?: LedgerTransaction;

  /** The payment provider's id for this transaction, when there is one. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  providerReference: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  idempotencyKey: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  failureCode: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  failureReason: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', precision: 3 })
  updatedAt: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  completedAt: Date | null;
}
