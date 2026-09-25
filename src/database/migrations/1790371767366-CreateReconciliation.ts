import { MigrationInterface, QueryRunner } from 'typeorm';

/** Reconciliation runs and the differences they find. */
export class CreateReconciliation1790371767366 implements MigrationInterface {
  name = 'CreateReconciliation1790371767366';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "reconciliation_runs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "provider" character varying(50), "period_start" TIMESTAMP(3) WITH TIME ZONE NOT NULL, "period_end" TIMESTAMP(3) WITH TIME ZONE NOT NULL, "status" character varying(20) NOT NULL, "trigger" character varying(20) NOT NULL, "requested_by_user_id" uuid, "summary" jsonb NOT NULL DEFAULT '{}', "error" character varying(1000), "finished_at" TIMESTAMP(3) WITH TIME ZONE, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_reconciliation_runs_period" CHECK ("period_end" > "period_start"), CONSTRAINT "chk_reconciliation_runs_trigger" CHECK ("trigger" IN ('schedule', 'manual')), CONSTRAINT "chk_reconciliation_runs_status" CHECK ("status" IN ('running', 'completed', 'failed')), CONSTRAINT "pk_reconciliation_runs" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_reconciliation_runs_created" ON "reconciliation_runs"  ("created_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_reconciliation_runs_scheduled_ledger" ON "reconciliation_runs"  ("period_start") WHERE "trigger" = 'schedule' AND "provider" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_reconciliation_runs_scheduled_provider" ON "reconciliation_runs"  ("provider", "period_start") WHERE "trigger" = 'schedule' AND "provider" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "reconciliation_items" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "run_id" uuid NOT NULL, "kind" character varying(20) NOT NULL, "issue" character varying(50) NOT NULL, "reference" character varying(255), "target_id" uuid, "finstack" jsonb, "provider" jsonb, "status" character varying(20) NOT NULL, "resolution_note" character varying(500), "resolved_by_user_id" uuid, "resolved_at" TIMESTAMP(3) WITH TIME ZONE, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_reconciliation_items_status" CHECK ("status" IN ('open', 'resolved', 'auto_resolved')), CONSTRAINT "chk_reconciliation_items_issue" CHECK ("issue" IN ('missing_in_finstack', 'not_credited', 'credited_without_payment', 'amount_mismatch', 'status_mismatch', 'late_settlement', 'balance_discrepancy', 'trial_balance_mismatch')), CONSTRAINT "chk_reconciliation_items_kind" CHECK ("kind" IN ('payment', 'payout', 'ledger')), CONSTRAINT "pk_reconciliation_items" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_reconciliation_items_status_created_id" ON "reconciliation_items"  ("status", "created_at", "id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_reconciliation_items_run" ON "reconciliation_items"  ("run_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "reconciliation_items" ADD CONSTRAINT "fk_reconciliation_items_run" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reconciliation_items" DROP CONSTRAINT "fk_reconciliation_items_run"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_reconciliation_items_run"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_reconciliation_items_status_created_id"`,
    );
    await queryRunner.query(`DROP TABLE "reconciliation_items"`);
    await queryRunner.query(
      `DROP INDEX "public"."uq_reconciliation_runs_scheduled_provider"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_reconciliation_runs_scheduled_ledger"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_reconciliation_runs_created"`,
    );
    await queryRunner.query(`DROP TABLE "reconciliation_runs"`);
  }
}
