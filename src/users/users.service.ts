import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import type { Cursor } from '../common/pagination/cursor';
import { isUniqueViolation } from '../database/postgres-errors';
import { User, UserStatus } from './user.entity';
import { EmailAlreadyRegisteredException } from './users.errors';

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Relies on the unique index rather than a "check then insert", so two
   * concurrent registrations for one email cannot both succeed.
   */
  async create(input: CreateUserInput): Promise<User> {
    try {
      const user = await this.users.save(
        this.users.create({
          ...input,
          email: UsersService.normalizeEmail(input.email),
        }),
      );
      return this.users.findOneByOrFail({ id: user.id });
    } catch (error) {
      if (isUniqueViolation(error, 'uq_users_email')) {
        throw new EmailAlreadyRegisteredException();
      }
      throw error;
    }
  }

  findById(id: string): Promise<User | null> {
    return this.users.findOneBy({ id });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.users.findOneBy({ email: UsersService.normalizeEmail(email) });
  }

  /** Admin search: email contains `email`, newest first, keyset-paginated. */
  async search(
    filter: { email?: string; status?: UserStatus },
    options: { limit: number; before?: Cursor },
  ): Promise<{ users: User[]; next: Cursor | null }> {
    const query = this.users
      .createQueryBuilder('user')
      .orderBy('user.createdAt', 'DESC')
      .addOrderBy('user.id', 'DESC')
      .limit(options.limit + 1);
    if (filter.email) {
      query.andWhere('user.email ILIKE :email', {
        email: `%${escapeLike(filter.email.toLowerCase())}%`,
      });
    }
    if (filter.status) {
      query.andWhere('user.status = :status', { status: filter.status });
    }
    if (options.before) {
      query.andWhere(
        '(user.createdAt, user.id) < (:beforeCreatedAt, :beforeId)',
        {
          beforeCreatedAt: options.before.createdAt,
          beforeId: options.before.id,
        },
      );
    }
    const rows = await query.getMany();
    const users = rows.slice(0, options.limit);
    const last = users.at(-1);
    return {
      users,
      next:
        rows.length > options.limit && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }

  async setStatus(
    id: string,
    status: UserStatus,
    manager?: EntityManager,
  ): Promise<void> {
    await (manager ?? this.users.manager).update(User, { id }, { status });
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.users
      .createQueryBuilder('user')
      .select('user.status', 'status')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('user.status')
      .getRawMany<{ status: string; count: number }>();
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  /** The only way to load a password hash. Use for credential checks only. */
  findByEmailWithPasswordHash(email: string): Promise<User | null> {
    return this.users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', {
        email: UsersService.normalizeEmail(email),
      })
      .getOne();
  }
}

/** Escapes LIKE wildcards in user input. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
