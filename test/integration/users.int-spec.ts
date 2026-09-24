import { TestingModule } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';
import { User } from '../../src/users/user.entity';
import { EmailAlreadyRegisteredException } from '../../src/users/users.errors';
import { UsersModule } from '../../src/users/users.module';
import { UsersService } from '../../src/users/users.service';
import { createTestModule } from '../utils/create-test-module';
import { resetDatabase } from '../utils/database';

describe('UsersService (integration)', () => {
  let moduleRef: TestingModule;
  let users: UsersService;
  let dataSource: DataSource;

  const input = {
    email: 'Ada@Example.com',
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$hash',
    firstName: 'Ada',
    lastName: 'Lovelace',
  };

  beforeAll(async () => {
    moduleRef = await createTestModule([UsersModule]);
    users = moduleRef.get(UsersService);
    dataSource = moduleRef.get(DataSource);
  });

  beforeEach(() => resetDatabase(dataSource));

  afterAll(() => moduleRef.close());

  it('creates a user with a normalised email and database defaults', async () => {
    const user = await users.create(input);

    expect(user).toMatchObject({
      email: 'ada@example.com',
      role: 'user',
      status: 'active',
    });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.createdAt).toBeInstanceOf(Date);
  });

  it('never loads the password hash unless explicitly asked', async () => {
    const created = await users.create(input);

    expect(created.passwordHash).toBeUndefined();
    expect((await users.findById(created.id))?.passwordHash).toBeUndefined();
    expect(
      (await users.findByEmailWithPasswordHash('ADA@example.com'))
        ?.passwordHash,
    ).toBe(input.passwordHash);
  });

  it('rejects a duplicate email regardless of casing', async () => {
    await users.create(input);

    await expect(
      users.create({ ...input, email: 'ADA@EXAMPLE.COM' }),
    ).rejects.toThrow(EmailAlreadyRegisteredException);
  });

  it('lets exactly one of several concurrent registrations win', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () => users.create(input)),
    );

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter(
      (a): a is PromiseRejectedResult => a.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    rejected.forEach((attempt) =>
      expect(attempt.reason).toBeInstanceOf(EmailAlreadyRegisteredException),
    );
    await expect(dataSource.getRepository(User).count()).resolves.toBe(1);
  });

  it('is protected by a database constraint even if the app forgets to normalise', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO users (email, password_hash, first_name, last_name)
         VALUES ('Mixed@Case.com', 'x', 'A', 'B')`,
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('rejects unknown roles and statuses at the database level', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, role)
         VALUES ('a@b.com', 'x', 'A', 'B', 'superuser')`,
      ),
    ).rejects.toThrow(/chk_users_role/);
  });
});
