import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Organizations can own wallets, transactions, payments and idempotency
 * keys. Each row has exactly one owner: `user_id` or `organization_id`.
 */
export class OrganizationOwnership1790337831850 implements MigrationInterface {
  name = 'OrganizationOwnership1790337831850';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, onDelete] of [
      ['wallets', 'RESTRICT'],
      ['transactions', 'RESTRICT'],
      ['payments', 'RESTRICT'],
      ['idempotency_keys', 'CASCADE'],
    ] as const) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD "organization_id" uuid`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "user_id" DROP NOT NULL`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "chk_${table}_owner" CHECK (num_nonnulls("user_id", "organization_id") = 1)`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "fk_${table}_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE ${onDelete} ON UPDATE NO ACTION`,
      );
    }

    // The payer's email, previously looked up from the user at checkout.
    await queryRunner.query(
      `ALTER TABLE "payments" ADD "customer_email" character varying(320)`,
    );
    await queryRunner.query(
      `UPDATE "payments" p SET "customer_email" = u."email" FROM "users" u WHERE u."id" = p."user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "customer_email" SET NOT NULL`,
    );

    // Uniqueness per owner: partial indexes, one per owner column.
    await queryRunner.query(`DROP INDEX "public"."uq_wallets_user_currency"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_wallets_user_currency" ON "wallets" ("user_id", "currency") WHERE "user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_wallets_org_currency" ON "wallets" ("organization_id", "currency") WHERE "organization_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_wallets_org_primary" ON "wallets" ("organization_id") WHERE "is_primary" AND "organization_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `DROP INDEX "public"."uq_transactions_user_idempotency_key"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_transactions_user_idempotency_key" ON "transactions" ("user_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL AND "user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_transactions_org_idempotency_key" ON "transactions" ("organization_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL AND "organization_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_transactions_org_created_id" ON "transactions" ("organization_id", "created_at", "id")`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_payments_org_created" ON "payments" ("organization_id", "created_at")`,
    );

    await queryRunner.query(
      `DROP INDEX "public"."uq_idempotency_keys_user_key"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_idempotency_keys_user_key" ON "idempotency_keys" ("user_id", "key") WHERE "user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_idempotency_keys_org_key" ON "idempotency_keys" ("organization_id", "key") WHERE "organization_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Organization-owned rows can't be represented before this migration.
    await queryRunner.query(
      `DELETE FROM "idempotency_keys" WHERE "organization_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `DROP INDEX "public"."uq_idempotency_keys_org_key"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_idempotency_keys_user_key"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_idempotency_keys_user_key" ON "idempotency_keys" ("user_id", "key")`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_payments_org_created"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_transactions_org_created_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_transactions_org_idempotency_key"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_transactions_user_idempotency_key"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_transactions_user_idempotency_key" ON "transactions" ("user_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL`,
    );
    await queryRunner.query(`DROP INDEX "public"."uq_wallets_org_primary"`);
    await queryRunner.query(`DROP INDEX "public"."uq_wallets_org_currency"`);
    await queryRunner.query(`DROP INDEX "public"."uq_wallets_user_currency"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_wallets_user_currency" ON "wallets" ("user_id", "currency")`,
    );

    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN "customer_email"`,
    );

    for (const table of [
      'idempotency_keys',
      'payments',
      'transactions',
      'wallets',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT "fk_${table}_organization"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT "chk_${table}_owner"`,
      );
      // Fails if organization-owned rows exist: they must be removed first.
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "user_id" SET NOT NULL`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN "organization_id"`,
      );
    }
  }
}
