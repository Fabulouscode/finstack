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
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../database/transformers';
import { FxQuote } from '../fx/fx-quote.entity';
import { Organization } from '../organizations/organization.entity';
import { Transaction } from '../transactions/transaction.entity';
import { User } from '../users/user.entity';
import { Wallet } from '../wallets/wallet.entity';

/**
 * Provider-side details of an incoming payment. Its lifecycle (pending ->
 * successful/failed) lives on the linked transaction, the single source of
 * truth for status.
 */
@Entity({ name: 'payments' })
@Index('uq_payments_provider_reference', ['provider', 'providerReference'], {
  unique: true,
  where: '"provider_reference" IS NOT NULL',
})
@Index('idx_payments_user_created', ['userId', 'createdAt'])
@Index('idx_payments_org_created', ['organizationId', 'createdAt'])
@Check('chk_payments_owner', `num_nonnulls("user_id", "organization_id") = 1`)
export class Payment {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_payments' })
  id: string;

  @Index('uq_payments_transaction_id', { unique: true })
  @Column({ type: 'uuid' })
  transactionId: string;

  @OneToOne(() => Transaction, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'transaction_id',
    foreignKeyConstraintName: 'fk_payments_transaction',
  })
  transaction?: Transaction;

  /** The wallet owner being paid: a user (top-up) or an organization (collection). */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'fk_payments_user' })
  user?: User;

  @Column({ type: 'uuid', nullable: true })
  organizationId: string | null;

  @ManyToOne(() => Organization, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_payments_organization',
  })
  organization?: Organization;

  /** Who pays, sent to the provider's checkout (receipts, fraud checks). */
  @Column({ type: 'varchar', length: 320 })
  customerEmail: string;

  /** The wallet the payment will be credited to (chosen by the crediting rule). */
  @Column({ type: 'uuid' })
  walletId: string;

  @ManyToOne(() => Wallet, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'wallet_id',
    foreignKeyConstraintName: 'fk_payments_wallet',
  })
  wallet?: Wallet;

  @Column({ type: 'varchar', length: 50 })
  provider: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  providerReference: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  authorizationUrl: string | null;

  /** Charged to the customer, in minor units of `currency`. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column({ type: 'char', length: 3 })
  currency: string;

  /** Set when the charged currency differs from the wallet's. */
  @Column({ type: 'uuid', nullable: true })
  fxQuoteId: string | null;

  @ManyToOne(() => FxQuote, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'fx_quote_id',
    foreignKeyConstraintName: 'fk_payments_fx_quote',
  })
  fxQuote?: FxQuote;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', precision: 3 })
  updatedAt: Date;
}
