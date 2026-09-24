import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../database/postgres-errors';
import { User } from './user.entity';
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
