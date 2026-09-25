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
import { Organization } from '../organizations/organization.entity';
import { User } from '../users/user.entity';

export enum WalletStatus {
  Active = 'active',
  /** Temporarily blocked (e.g. compliance review): no money movement. */
  Frozen = 'frozen',
  Closed = 'closed',
}

/**
 * A balance in one currency owned by a user. Depending on WALLETS_PER_OWNER a
 * user holds one wallet or one per currency; exactly one is primary and
 * receives foreign-currency payments after FX conversion (ADR 0010).
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
// A wallet belongs to exactly one owner: a user or an organization.
@Check('chk_wallets_owner', `num_nonnulls("user_id", "organization_id") = 1`)
// At most one wallet per currency per owner; also serves "my wallets"
// lookups. Partial, because the other owner column is null.
@Index('uq_wallets_user_currency', ['userId', 'currency'], {
  unique: true,
  where: '"user_id" IS NOT NULL',
})
@Index('uq_wallets_org_currency', ['organizationId', 'currency'], {
  unique: true,
  where: '"organization_id" IS NOT NULL',
})
// At most one primary wallet per owner. In `single` mode every wallet is
// created primary, so this index alone guarantees one wallet per owner.
@Index('uq_wallets_user_primary', ['userId'], {
  unique: true,
  where: '"is_primary"',
})
@Index('uq_wallets_org_primary', ['organizationId'], {
  unique: true,
  where: '"is_primary" AND "organization_id" IS NOT NULL',
})
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

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'fk_wallets_user' })
  user?: User;

  @Column({ type: 'uuid', nullable: true })
  organizationId: string | null;

  @ManyToOne(() => Organization, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_wallets_organization',
  })
  organization?: Organization;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'varchar', length: 20, default: WalletStatus.Active })
  status: WalletStatus;

  /** Receives foreign-currency payments (converted) when no wallet matches. */
  @Column({ type: 'boolean', default: false })
  isPrimary: boolean;

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
