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
import { User } from '../users/user.entity';

/**
 * A bank account payouts can be sent to, saved with the provider. Only the
 * provider's recipient reference and the last digits are kept; the full
 * account number stays with the provider.
 */
@Entity({ name: 'payout_destinations' })
@Check(
  'chk_payout_destinations_owner',
  `num_nonnulls("user_id", "organization_id") = 1`,
)
@Check('chk_payout_destinations_currency', `"currency" ~ '^[A-Z]{3}$'`)
// One active destination per owner and provider account.
@Index(
  'uq_payout_destinations_user_recipient',
  ['userId', 'provider', 'recipientReference'],
  { unique: true, where: '"user_id" IS NOT NULL AND "removed_at" IS NULL' },
)
@Index(
  'uq_payout_destinations_org_recipient',
  ['organizationId', 'provider', 'recipientReference'],
  {
    unique: true,
    where: '"organization_id" IS NOT NULL AND "removed_at" IS NULL',
  },
)
export class PayoutDestination {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_payout_destinations',
  })
  id: string;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_payout_destinations_user',
  })
  user?: User;

  @Column({ type: 'uuid', nullable: true })
  organizationId: string | null;

  @ManyToOne(() => Organization, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_payout_destinations_organization',
  })
  organization?: Organization;

  @Column({ type: 'varchar', length: 50 })
  provider: string;

  @Column({ type: 'char', length: 3 })
  currency: string;

  /** The provider's id for the account, e.g. a Paystack recipient code. */
  @Column({ type: 'varchar', length: 100 })
  recipientReference: string;

  @Column({ type: 'varchar', length: 20 })
  bankCode: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  bankName: string | null;

  /** As verified by the provider where it can (e.g. NUBAN name enquiry). */
  @Column({ type: 'varchar', length: 200 })
  accountName: string;

  @Column({ type: 'varchar', length: 4 })
  accountNumberLast4: string;

  /** The owner's own name for it, e.g. "Payroll account". */
  @Column({ type: 'varchar', length: 100, nullable: true })
  label: string | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  /** Removed destinations are kept for the payouts that used them. */
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  removedAt: Date | null;
}
