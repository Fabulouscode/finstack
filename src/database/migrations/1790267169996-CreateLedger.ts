import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLedger1790267169996 implements MigrationInterface {
  name = 'CreateLedger1790267169996';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ledger_accounts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "code" character varying(100), "name" character varying(200) NOT NULL, "type" character varying(20) NOT NULL, "normal_balance" character varying(10) NOT NULL, "currency" character(3) NOT NULL, "balance" bigint NOT NULL DEFAULT '0', "allow_negative_balance" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_ledger_accounts_non_negative" CHECK ("allow_negative_balance" OR "balance" >= 0), CONSTRAINT "chk_ledger_accounts_normal_balance" CHECK ("normal_balance" IN ('debit', 'credit')), CONSTRAINT "chk_ledger_accounts_type" CHECK ("type" IN ('asset', 'liability', 'equity', 'revenue', 'expense')), CONSTRAINT "chk_ledger_accounts_currency" CHECK ("currency" ~ '^[A-Z]{3}$'), CONSTRAINT "pk_ledger_accounts" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_ledger_accounts_code" ON "ledger_accounts"  ("code") `,
    );
    await queryRunner.query(
      `CREATE TABLE "ledger_transactions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "reference" character varying(255) NOT NULL, "description" character varying(500) NOT NULL, "currency" character(3) NOT NULL, "amount" bigint NOT NULL, "reversal_of_id" uuid, "metadata" jsonb NOT NULL DEFAULT '{}', "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_ledger_transactions_amount_positive" CHECK ("amount" > 0), CONSTRAINT "chk_ledger_transactions_currency" CHECK ("currency" ~ '^[A-Z]{3}$'), CONSTRAINT "pk_ledger_transactions" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_ledger_transactions_reference" ON "ledger_transactions"  ("reference") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_ledger_transactions_reversal_of_id" ON "ledger_transactions"  ("reversal_of_id") WHERE "reversal_of_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "ledger_entries" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "ledger_transaction_id" uuid NOT NULL, "ledger_account_id" uuid NOT NULL, "direction" character varying(10) NOT NULL, "amount" bigint NOT NULL, "currency" character(3) NOT NULL, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_ledger_entries_direction" CHECK ("direction" IN ('debit', 'credit')), CONSTRAINT "chk_ledger_entries_amount_positive" CHECK ("amount" > 0), CONSTRAINT "pk_ledger_entries" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ledger_entries_account_created_id" ON "ledger_entries"  ("ledger_account_id", "created_at", "id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ledger_entries_ledger_transaction_id" ON "ledger_entries"  ("ledger_transaction_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "ledger_transactions" ADD CONSTRAINT "fk_ledger_transactions_reversal_of" FOREIGN KEY ("reversal_of_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "ledger_entries" ADD CONSTRAINT "fk_ledger_entries_ledger_transaction" FOREIGN KEY ("ledger_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "ledger_entries" ADD CONSTRAINT "fk_ledger_entries_ledger_account" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ledger_entries" DROP CONSTRAINT "fk_ledger_entries_ledger_account"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ledger_entries" DROP CONSTRAINT "fk_ledger_entries_ledger_transaction"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ledger_transactions" DROP CONSTRAINT "fk_ledger_transactions_reversal_of"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_ledger_entries_ledger_transaction_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_ledger_entries_account_created_id"`,
    );
    await queryRunner.query(`DROP TABLE "ledger_entries"`);
    await queryRunner.query(
      `DROP INDEX "public"."uq_ledger_transactions_reversal_of_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_ledger_transactions_reference"`,
    );
    await queryRunner.query(`DROP TABLE "ledger_transactions"`);
    await queryRunner.query(`DROP INDEX "public"."uq_ledger_accounts_code"`);
    await queryRunner.query(`DROP TABLE "ledger_accounts"`);
  }
}
