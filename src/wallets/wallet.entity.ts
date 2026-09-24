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
import { LedgerAccount } from '../ledger/ledger-account.entity';
import { sqlList } from '../ledger/ledger.types';
import { User } from '../users/user.entity';

export enum WalletStatus {
  Active = 'active',
  /** Temporarily blocked (e.g. compliance review): no money movement. */
  Frozen = 'frozen',
  Closed = 'closed',
}

/**
 * A user's single wallet, in a base currency chosen at creation (USD by
 * default). Payments in other currencies are converted by the payment
 * provider before settlement (see ADR 0008).
 *
 * The wallet holds no amounts itself: each balance is a ledger account, so
 * every change is a ledger posting.
 */
@Entity({ name: 'wallets' })
@Check('chk_wallets_currency', `"currency" ~ '^[A-Z]{3}$'`)
@Check(
  'chk_wallets_status',
  `"status" IN (${sqlList(Object.values(WalletStatus))})`,
)
// One wallet per user; also serves "my wallet" lookups.
@Index('uq_wallets_user_id', ['userId'], { unique: true })
@Index('uq_wallets_available_account_id', ['availableAccountId'], {
  unique: true,
})
@Index('uq_wallets_pending_account_id', ['pendingAccountId'], { unique: true })
@Index('uq_wallets_reserved_account_id', ['reservedAccountId'], {
  unique: true,
})
export class Wallet {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_wallets' })
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'fk_wallets_user' })
  user?: User;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'varchar', length: 20, default: WalletStatus.Active })
  status: WalletStatus;

  /** Spendable funds. */
  @Column({ type: 'uuid' })
  availableAccountId: string;

  @ManyToOne(() => LedgerAccount, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'available_account_id',
    foreignKeyConstraintName: 'fk_wallets_available_account',
  })
  availableAccount?: LedgerAccount;

  /** Incoming funds not yet settled (e.g. a payment awaiting confirmation). */
  @Column({ type: 'uuid' })
  pendingAccountId: string;

  @ManyToOne(() => LedgerAccount, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'pending_account_id',
    foreignKeyConstraintName: 'fk_wallets_pending_account',
  })
  pendingAccount?: LedgerAccount;

  /** Funds on hold (e.g. an authorised but uncaptured withdrawal). */
  @Column({ type: 'uuid' })
  reservedAccountId: string;

  @ManyToOne(() => LedgerAccount, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'reserved_account_id',
    foreignKeyConstraintName: 'fk_wallets_reserved_account',
  })
  reservedAccount?: LedgerAccount;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
