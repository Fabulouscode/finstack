import { MigrationInterface, QueryRunner } from 'typeorm';

/** Fee rules, and the fee charged on each transaction. */
export class CreateFees1790437838153 implements MigrationInterface {
  name = 'CreateFees1790437838153';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "fee_rules" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "operation" character varying(20) NOT NULL, "currency" character(3) NOT NULL, "organization_id" uuid, "fixed_amount" bigint NOT NULL DEFAULT '0', "percentage_bps" integer NOT NULL DEFAULT '0', "min_amount" bigint NOT NULL DEFAULT '0', "max_amount" bigint, "created_by_user_id" uuid, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "superseded_at" TIMESTAMP(3) WITH TIME ZONE, CONSTRAINT "chk_fee_rules_percentage" CHECK ("percentage_bps" BETWEEN 0 AND 10000), CONSTRAINT "chk_fee_rules_amounts" CHECK ("fixed_amount" >= 0 AND "min_amount" >= 0 AND ("max_amount" IS NULL OR "max_amount" >= "min_amount")), CONSTRAINT "chk_fee_rules_currency" CHECK ("currency" ~ '^[A-Z]{3}$'), CONSTRAINT "chk_fee_rules_operation" CHECK ("operation" IN ('payment', 'payout', 'transfer')), CONSTRAINT "pk_fee_rules" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_fee_rules_active_org" ON "fee_rules"  ("operation", "currency", "organization_id") WHERE "organization_id" IS NOT NULL AND "superseded_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_fee_rules_active_default" ON "fee_rules"  ("operation", "currency") WHERE "organization_id" IS NULL AND "superseded_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD "fee_amount" bigint NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD "fee_currency" character(3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD "fee_rule_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "chk_transactions_fee" CHECK ("fee_amount" >= 0 AND ("fee_amount" = 0 OR "fee_currency" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "fee_rules" ADD CONSTRAINT "fk_fee_rules_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "fk_transactions_fee_rule" FOREIGN KEY ("fee_rule_id") REFERENCES "fee_rules"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP CONSTRAINT "fk_transactions_fee_rule"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fee_rules" DROP CONSTRAINT "fk_fee_rules_organization"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP CONSTRAINT "chk_transactions_fee"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP COLUMN "fee_rule_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP COLUMN "fee_currency"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP COLUMN "fee_amount"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_fee_rules_active_default"`,
    );
    await queryRunner.query(`DROP INDEX "public"."uq_fee_rules_active_org"`);
    await queryRunner.query(`DROP TABLE "fee_rules"`);
  }
}
