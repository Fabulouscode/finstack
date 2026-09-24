import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWallets1790267727017 implements MigrationInterface {
  name = 'CreateWallets1790267727017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "wallets" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "currency" character(3) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'active', "available_account_id" uuid NOT NULL, "pending_account_id" uuid NOT NULL, "reserved_account_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_wallets_status" CHECK ("status" IN ('active', 'frozen', 'closed')), CONSTRAINT "chk_wallets_currency" CHECK ("currency" ~ '^[A-Z]{3}$'), CONSTRAINT "pk_wallets" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_wallets_reserved_account_id" ON "wallets"  ("reserved_account_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_wallets_pending_account_id" ON "wallets"  ("pending_account_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_wallets_available_account_id" ON "wallets"  ("available_account_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_wallets_user_currency" ON "wallets"  ("user_id", "currency") `,
    );
    await queryRunner.query(
      `ALTER TABLE "wallets" ADD CONSTRAINT "fk_wallets_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallets" ADD CONSTRAINT "fk_wallets_available_account" FOREIGN KEY ("available_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallets" ADD CONSTRAINT "fk_wallets_pending_account" FOREIGN KEY ("pending_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallets" ADD CONSTRAINT "fk_wallets_reserved_account" FOREIGN KEY ("reserved_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "wallets" DROP CONSTRAINT "fk_wallets_reserved_account"`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallets" DROP CONSTRAINT "fk_wallets_pending_account"`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallets" DROP CONSTRAINT "fk_wallets_available_account"`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallets" DROP CONSTRAINT "fk_wallets_user"`,
    );
    await queryRunner.query(`DROP INDEX "public"."uq_wallets_user_currency"`);
    await queryRunner.query(
      `DROP INDEX "public"."uq_wallets_available_account_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_wallets_pending_account_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_wallets_reserved_account_id"`,
    );
    await queryRunner.query(`DROP TABLE "wallets"`);
  }
}
