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
import { sqlList } from '../ledger/ledger.types';
import { User } from '../users/user.entity';
import { OrgRole } from './organization-permissions';
import { Organization } from './organization.entity';

@Entity({ name: 'organization_members' })
@Check(
  'chk_organization_members_role',
  `"role" IN (${sqlList(Object.values(OrgRole))})`,
)
@Index('uq_organization_members_org_user', ['organizationId', 'userId'], {
  unique: true,
})
// Exactly-one-owner is enforced by the database: at most one owner row...
@Index('uq_organization_members_owner', ['organizationId'], {
  unique: true,
  where: `"role" = 'owner'`,
})
// ...and "my organizations" lookups.
@Index('idx_organization_members_user_id', ['userId'])
export class Membership {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_organization_members',
  })
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_organization_members_organization',
  })
  organization?: Organization;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_organization_members_user',
  })
  user?: User;

  @Column({ type: 'varchar', length: 20 })
  role: OrgRole;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
