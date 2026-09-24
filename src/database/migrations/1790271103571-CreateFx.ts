import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFx1790271103571 implements MigrationInterface {
  name = 'CreateFx1790271103571';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "fx_rates" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "base_currency" character(3) NOT NULL, "quote_currency" character(3) NOT NULL, "rate" numeric(24,10) NOT NULL, "source" character varying(50) NOT NULL, "created_by_user_id" uuid, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_fx_rates_rate_positive" CHECK ("rate" > 0), CONSTRAINT "chk_fx_rates_distinct_currencies" CHECK ("base_currency" <> "quote_currency"), CONSTRAINT "pk_fx_rates" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_fx_rates_pair_created" ON "fx_rates"  ("base_currency", "quote_currency", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "fx_quotes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid, "fx_rate_id" uuid NOT NULL, "source_currency" character(3) NOT NULL, "target_currency" character(3) NOT NULL, "source_amount" bigint NOT NULL, "target_amount" bigint NOT NULL, "gross_target_amount" bigint NOT NULL, "spread_bps" integer NOT NULL, "rate_base_currency" character(3) NOT NULL, "rate_quote_currency" character(3) NOT NULL, "rate" numeric(24,10) NOT NULL, "expires_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL, "consumed_at" TIMESTAMP(3) WITH TIME ZONE, "conversion_reference" character varying(255), "source_transaction_id" uuid, "target_transaction_id" uuid, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_fx_quotes_consumption_complete" CHECK (("consumed_at" IS NULL) = ("conversion_reference" IS NULL)), CONSTRAINT "chk_fx_quotes_target_within_gross" CHECK ("target_amount" <= "gross_target_amount"), CONSTRAINT "chk_fx_quotes_spread" CHECK ("spread_bps" >= 0 AND "spread_bps" < 10000), CONSTRAINT "chk_fx_quotes_amounts_positive" CHECK ("source_amount" > 0 AND "target_amount" > 0), CONSTRAINT "chk_fx_quotes_distinct_currencies" CHECK ("source_currency" <> "target_currency"), CONSTRAINT "pk_fx_quotes" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_fx_quotes_conversion_reference" ON "fx_quotes"  ("conversion_reference") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_fx_quotes_user_id" ON "fx_quotes"  ("user_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "fx_rates" ADD CONSTRAINT "fk_fx_rates_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "fx_quotes" ADD CONSTRAINT "fk_fx_quotes_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "fx_quotes" ADD CONSTRAINT "fk_fx_quotes_fx_rate" FOREIGN KEY ("fx_rate_id") REFERENCES "fx_rates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "fx_quotes" ADD CONSTRAINT "fk_fx_quotes_source_transaction" FOREIGN KEY ("source_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "fx_quotes" ADD CONSTRAINT "fk_fx_quotes_target_transaction" FOREIGN KEY ("target_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "fx_quotes" DROP CONSTRAINT "fk_fx_quotes_target_transaction"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fx_quotes" DROP CONSTRAINT "fk_fx_quotes_source_transaction"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fx_quotes" DROP CONSTRAINT "fk_fx_quotes_fx_rate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fx_quotes" DROP CONSTRAINT "fk_fx_quotes_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fx_rates" DROP CONSTRAINT "fk_fx_rates_created_by"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_fx_quotes_user_id"`);
    await queryRunner.query(
      `DROP INDEX "public"."uq_fx_quotes_conversion_reference"`,
    );
    await queryRunner.query(`DROP TABLE "fx_quotes"`);
    await queryRunner.query(`DROP INDEX "public"."idx_fx_rates_pair_created"`);
    await queryRunner.query(`DROP TABLE "fx_rates"`);
  }
}
