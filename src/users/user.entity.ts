import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Platform-wide role. Organization-level roles live with organizations. */
export enum UserRole {
  User = 'user',
  Admin = 'admin',
}

export enum UserStatus {
  Active = 'active',
  Suspended = 'suspended',
}

const sqlList = (values: string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

@Entity({ name: 'users' })
// Emails are normalised in the app; the database guarantees it so the unique
// index can never be bypassed by casing ("Ada@x.com" vs "ada@x.com").
@Check('chk_users_email_lowercase', `"email" = lower("email")`)
@Check('chk_users_role', `"role" IN (${sqlList(Object.values(UserRole))})`)
@Check(
  'chk_users_status',
  `"status" IN (${sqlList(Object.values(UserStatus))})`,
)
export class User {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_users' })
  id: string;

  @Index('uq_users_email', { unique: true })
  @Column({ type: 'varchar', length: 320 })
  email: string;

  /** Never loaded unless explicitly selected, so it cannot leak by accident. */
  @Column({ type: 'text', select: false })
  passwordHash: string;

  @Column({ type: 'varchar', length: 100 })
  firstName: string;

  @Column({ type: 'varchar', length: 100 })
  lastName: string;

  @Column({ type: 'varchar', length: 20, default: UserRole.User })
  role: UserRole;

  @Column({ type: 'varchar', length: 20, default: UserStatus.Active })
  status: UserStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
