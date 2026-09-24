import { MigrationInterface, QueryRunner } from 'typeorm';

export class FlexibleWallets1790273483253 implements MigrationInterface {
  name = 'FlexibleWallets1790273483253';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uq_wallets_user_id"`);
    await queryRunner.query(
      `ALTER TABLE "wallets" ADD "is_primary" boolean NOT NULL DEFAULT false`,
    );
    // Under the previous one-wallet-per-user rule, every existing wallet is
    // its owner's only wallet, and therefore its primary one.
    await queryRunner.query(`UPDATE "wallets" SET "is_primary" = true`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_wallets_user_primary" ON "wallets"  ("user_id") WHERE "is_primary"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_wallets_user_currency" ON "wallets"  ("user_id", "currency") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const multi = (await queryRunner.query(
      `SELECT user_id FROM wallets GROUP BY user_id HAVING count(*) > 1 LIMIT 1`,
    )) as unknown[];
    if (multi.length > 0) {
      throw new Error(
        'Cannot revert to one wallet per user: some users hold several wallets.',
      );
    }

    await queryRunner.query(`DROP INDEX "public"."uq_wallets_user_currency"`);
    await queryRunner.query(`DROP INDEX "public"."uq_wallets_user_primary"`);
    await queryRunner.query(`ALTER TABLE "wallets" DROP COLUMN "is_primary"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_wallets_user_id" ON "wallets" ("user_id") `,
    );
  }
}
