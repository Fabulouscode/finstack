import { MigrationInterface, QueryRunner } from 'typeorm';

/** Staff roles: support, risk and finance, alongside user and admin. */
export class PlatformRoles1790453185268 implements MigrationInterface {
  name = 'PlatformRoles1790453185268';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "chk_users_role"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "chk_users_role" CHECK ("role" IN ('user', 'support', 'risk', 'finance', 'admin'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Staff fall back to plain users; admins stay admins.
    await queryRunner.query(
      `UPDATE "users" SET "role" = 'user' WHERE "role" IN ('support', 'risk', 'finance')`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "chk_users_role"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "chk_users_role" CHECK ("role" IN ('user', 'admin'))`,
    );
  }
}
