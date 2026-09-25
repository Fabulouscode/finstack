import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { bigintTransformer } from '../database/transformers';
import { Organization } from '../organizations/organization.entity';
import { Transaction } from '../transactions/transaction.entity';
import { User } from '../users/user.entity';
import { Wallet } from '../wallets/wallet.entity';
import { PayoutDestination } from './payout-destination.entity';

/**
 * Provider-side details of money sent out of a wallet to a bank account.
 * Status lives on the linked transaction (type `withdrawal`).
 */
@Entity({ name: 'payouts' })
@Check('chk_payouts_owner', `num_nonnulls("user_id", "organization_id") = 1`)
@Check('chk_payouts_amount_positive', `"amount" > 0`)
@Index('idx_payouts_user_created', ['userId', 'createdAt'])
@Index('idx_payouts_org_created', ['organizationId', 'createdAt'])
export class Payout {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_payouts' })
  id: string;

  /** Sent to the provider as the idempotent transfer reference. */
  @Index('uq_payouts_reference', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  reference: string;

  @Index('uq_payouts_transaction_id', { unique: true })
  @Column({ type: 'uuid' })
  transactionId: string;

  @OneToOne(() => Transaction, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'transaction_id',
    foreignKeyConstraintName: 'fk_payouts_transaction',
  })
  transaction?: Transaction;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'fk_payouts_user' })
  user?: User;

  @Column({ type: 'uuid', nullable: true })
  organizationId: string | null;

  @ManyToOne(() => Organization, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_payouts_organization',
  })
  organization?: Organization;

  @Column({ type: 'uuid' })
  walletId: string;

  @ManyToOne(() => Wallet, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'wallet_id',
    foreignKeyConstraintName: 'fk_payouts_wallet',
  })
  wallet?: Wallet;

  @Column({ type: 'uuid' })
  destinationId: string;

  @ManyToOne(() => PayoutDestination, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'destination_id',
    foreignKeyConstraintName: 'fk_payouts_destination',
  })
  destination?: PayoutDestination;

  @Column({ type: 'varchar', length: 50 })
  provider: string;

  /** Minor units of `currency` (the wallet's). */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  narration: string | null;

  /** The provider's transfer id, once known. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  providerReference: string | null;

  /**
   * When the payout was first sent to the provider. Once set, the provider
   * is always asked about the payout before it is sent again.
   */
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  submittedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
