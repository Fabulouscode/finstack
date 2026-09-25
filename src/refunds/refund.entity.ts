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
import { Payment } from '../payments/payment.entity';
import { Transaction } from '../transactions/transaction.entity';
import { User } from '../users/user.entity';
import { Wallet } from '../wallets/wallet.entity';

/**
 * A (full or partial) refund of a payment. Its status lives on the linked
 * `refund` transaction (processing -> successful | failed); this row holds
 * the amounts and provider details.
 */
@Entity({ name: 'refunds' })
@Check(
  'chk_refunds_amounts_positive',
  `"amount" > 0 AND "wallet_debit_amount" > 0`,
)
@Check(
  'chk_refunds_fx_reversal',
  `"revenue_reversal" >= 0 AND "gross_reversal" = "wallet_debit_amount" + "revenue_reversal"`,
)
@Index('idx_refunds_payment_id', ['paymentId'])
@Index(
  'uq_refunds_provider_reference',
  ['provider', 'providerRefundReference'],
  {
    unique: true,
    where: '"provider_refund_reference" IS NOT NULL',
  },
)
@Index(
  'uq_refunds_requested_by_idempotency_key',
  ['requestedByUserId', 'idempotencyKey'],
  {
    unique: true,
  },
)
export class Refund {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_refunds' })
  id: string;

  /** Public reference, sent to the provider as the refund's idempotency key. */
  @Index('uq_refunds_reference', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  reference: string;

  @Column({ type: 'uuid' })
  paymentId: string;

  @ManyToOne(() => Payment, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'payment_id',
    foreignKeyConstraintName: 'fk_refunds_payment',
  })
  payment?: Payment;

  @Index('uq_refunds_transaction_id', { unique: true })
  @Column({ type: 'uuid' })
  transactionId: string;

  @OneToOne(() => Transaction, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'transaction_id',
    foreignKeyConstraintName: 'fk_refunds_transaction',
  })
  transaction?: Transaction;

  /** Returned to the customer, in the payment's (charged) currency. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'uuid' })
  walletId: string;

  @ManyToOne(() => Wallet, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'wallet_id',
    foreignKeyConstraintName: 'fk_refunds_wallet',
  })
  wallet?: Wallet;

  /** Taken from the wallet (held at request time), in the wallet currency. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  walletDebitAmount: bigint;

  @Column({ type: 'char', length: 3 })
  walletCurrency: string;

  /** For converted payments: FX revenue given back (wallet currency). */
  @Column({ type: 'bigint', transformer: bigintTransformer, default: 0 })
  revenueReversal: bigint;

  /** For converted payments: FX position unwound (wallet currency). */
  @Column({ type: 'bigint', transformer: bigintTransformer, default: 0 })
  grossReversal: bigint;

  @Column({ type: 'varchar', length: 50 })
  provider: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  providerRefundReference: string | null;

  @Column({ type: 'varchar', length: 500 })
  reason: string;

  @Column({ type: 'uuid' })
  requestedByUserId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'requested_by_user_id',
    foreignKeyConstraintName: 'fk_refunds_requested_by',
  })
  requestedBy?: User;

  @Column({ type: 'varchar', length: 255 })
  idempotencyKey: string;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
