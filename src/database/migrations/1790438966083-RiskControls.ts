import { MigrationInterface, QueryRunner } from 'typeorm';

/** Velocity limit rules; cooling-off for new payout destinations. */
export class RiskControls1790438966083 implements MigrationInterface {
  name = 'RiskControls1790438966083';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "limit_rules" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "operation" character varying(20) NOT NULL, "currency" character(3) NOT NULL, "organization_id" uuid, "max_per_transaction" bigint, "max_daily_amount" bigint, "max_daily_count" integer, "max_monthly_amount" bigint, "created_by_user_id" uuid, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "superseded_at" TIMESTAMP(3) WITH TIME ZONE, CONSTRAINT "chk_limit_rules_values" CHECK (("max_per_transaction" IS NULL OR "max_per_transaction" > 0)
   AND ("max_daily_amount" IS NULL OR "max_daily_amount" > 0)
   AND ("max_daily_count" IS NULL OR "max_daily_count" > 0)
   AND ("max_monthly_amount" IS NULL OR "max_monthly_amount" > 0)), CONSTRAINT "chk_limit_rules_currency" CHECK ("currency" ~ '^[A-Z]{3}$'), CONSTRAINT "chk_limit_rules_operation" CHECK ("operation" IN ('payment', 'payout', 'transfer')), CONSTRAINT "pk_limit_rules" PRIMARY KEY ("id"))`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_limit_rules_active_org" ON "limit_rules"  ("operation", "currency", "organization_id") WHERE "organization_id" IS NOT NULL AND "superseded_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_limit_rules_active_default" ON "limit_rules"  ("operation", "currency") WHERE "organization_id" IS NULL AND "superseded_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" ADD "payouts_available_at" TIMESTAMP(3) WITH TIME ZONE`,
    );
    // Existing accounts were usable at once; they stay that way.
    await queryRunner.query(
      `UPDATE "payout_destinations" SET "payouts_available_at" = "created_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" ALTER COLUMN "payouts_available_at" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "limit_rules" ADD CONSTRAINT "fk_limit_rules_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "limit_rules" DROP CONSTRAINT "fk_limit_rules_organization"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" DROP COLUMN "payouts_available_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_limit_rules_active_default"`,
    );
    await queryRunner.query(`DROP INDEX "public"."uq_limit_rules_active_org"`);
    await queryRunner.query(`DROP TABLE "limit_rules"`);
  }
}
