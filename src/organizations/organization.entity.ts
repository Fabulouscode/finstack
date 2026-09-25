import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum OrganizationStatus {
  Active = 'active',
  Suspended = 'suspended',
}

/** A business customer: owns wallets and API keys, acts through its members. */
@Entity({ name: 'organizations' })
@Check('chk_organizations_status', `"status" IN ('active', 'suspended')`)
export class Organization {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_organizations',
  })
  id: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 20, default: OrganizationStatus.Active })
  status: OrganizationStatus;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', precision: 3 })
  updatedAt: Date;
}
