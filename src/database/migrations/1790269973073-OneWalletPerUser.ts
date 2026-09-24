import { MigrationInterface, QueryRunner } from 'typeorm';

export class OneWalletPerUser1790269973073 implements MigrationInterface {
  name = 'OneWalletPerUser1790269973073';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fail with an actionable message instead of a bare unique violation if
    // an existing database already has users with several wallets.
    const duplicates = (await queryRunner.query(
      `SELECT user_id FROM wallets GROUP BY user_id HAVING count(*) > 1 LIMIT 5`,
    )) as { user_id: string }[];
    if (duplicates.length > 0) {
      throw new Error(
        `Cannot enforce one wallet per user: users with several wallets exist (e.g. ${duplicates
          .map((row) => row.user_id)
          .join(', ')}). Consolidate or close the extra wallets first.`,
      );
    }

    await queryRunner.query(`DROP INDEX "public"."uq_wallets_user_currency"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_wallets_user_id" ON "wallets"  ("user_id") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uq_wallets_user_id"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_wallets_user_currency" ON "wallets" ("user_id", "currency") `,
    );
  }
}
