import { MigrationInterface, QueryRunner } from 'typeorm';

/** Settlement holds: payment credits can stay pending before they're spendable. */
export class SettlementHolds1790370851547 implements MigrationInterface {
  name = 'SettlementHolds1790370851547';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payments" ADD "pending_amount" bigint NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD "funds_available_at" TIMESTAMP(3) WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "refunds" ADD "pending_hold_amount" bigint NOT NULL DEFAULT '0'`,
    );
    // Payments credited before settlement holds existed were available at once.
    await queryRunner.query(
      `UPDATE "payments" p SET "funds_available_at" = t."completed_at"
         FROM "transactions" t
        WHERE t."id" = p."transaction_id" AND t."completed_at" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payments_pending_release" ON "payments"  ("funds_available_at") WHERE "pending_amount" > 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "chk_payments_pending_amount" CHECK ("pending_amount" >= 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "chk_payments_pending_amount"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_payments_pending_release"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refunds" DROP COLUMN "pending_hold_amount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN "funds_available_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN "pending_amount"`,
    );
  }
}
