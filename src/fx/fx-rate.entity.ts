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
import { User } from '../users/user.entity';

/**
 * Insert-only rate history: setting a rate adds a row and the newest row per
 * pair wins, so every quote can be traced to the exact rate it used.
 *
 * `rate` is quote units per 1 base unit (USD/NGN 1550.25). It is stored as
 * an exact decimal and read as a string; arithmetic uses scaled bigints.
 */
@Entity({ name: 'fx_rates' })
@Check(
  'chk_fx_rates_distinct_currencies',
  `"base_currency" <> "quote_currency"`,
)
@Check('chk_fx_rates_rate_positive', `"rate" > 0`)
@Index('idx_fx_rates_pair_created', [
  'baseCurrency',
  'quoteCurrency',
  'createdAt',
])
export class FxRate {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_fx_rates' })
  id: string;

  @Column({ type: 'char', length: 3 })
  baseCurrency: string;

  @Column({ type: 'char', length: 3 })
  quoteCurrency: string;

  @Column({ type: 'numeric', precision: 24, scale: 10 })
  rate: string;

  /** Which RateProvider produced it, e.g. `admin`. */
  @Column({ type: 'varchar', length: 50 })
  source: string;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'created_by_user_id',
    foreignKeyConstraintName: 'fk_fx_rates_created_by',
  })
  createdBy?: User;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
