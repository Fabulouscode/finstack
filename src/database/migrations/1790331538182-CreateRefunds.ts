import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRefunds1790331538182 implements MigrationInterface {
  name = 'CreateRefunds1790331538182';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "refunds" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "reference" character varying(64) NOT NULL, "payment_id" uuid NOT NULL, "transaction_id" uuid NOT NULL, "amount" bigint NOT NULL, "currency" character(3) NOT NULL, "wallet_id" uuid NOT NULL, "wallet_debit_amount" bigint NOT NULL, "wallet_currency" character(3) NOT NULL, "revenue_reversal" bigint NOT NULL DEFAULT '0', "gross_reversal" bigint NOT NULL DEFAULT '0', "provider" character varying(50) NOT NULL, "provider_refund_reference" character varying(255), "reason" character varying(500) NOT NULL, "requested_by_user_id" uuid NOT NULL, "idempotency_key" character varying(255) NOT NULL, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "REL_8bb3b7579f49990d2e77684acd" UNIQUE ("transaction_id"), CONSTRAINT "chk_refunds_fx_reversal" CHECK ("revenue_reversal" >= 0 AND "gross_reversal" = "wallet_debit_amount" + "revenue_reversal"), CONSTRAINT "chk_refunds_amounts_positive" CHECK ("amount" > 0 AND "wallet_debit_amount" > 0), CONSTRAINT "pk_refunds" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_refunds_reference" ON "refunds"  ("reference") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_refunds_transaction_id" ON "refunds"  ("transaction_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_refunds_requested_by_idempotency_key" ON "refunds"  ("requested_by_user_id", "idempotency_key") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_refunds_provider_reference" ON "refunds"  ("provider", "provider_refund_reference") WHERE "provider_refund_reference" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_refunds_payment_id" ON "refunds"  ("payment_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "refunds" ADD CONSTRAINT "fk_refunds_payment" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "refunds" ADD CONSTRAINT "fk_refunds_transaction" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "refunds" ADD CONSTRAINT "fk_refunds_wallet" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "refunds" ADD CONSTRAINT "fk_refunds_requested_by" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refunds" DROP CONSTRAINT "fk_refunds_requested_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refunds" DROP CONSTRAINT "fk_refunds_wallet"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refunds" DROP CONSTRAINT "fk_refunds_transaction"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refunds" DROP CONSTRAINT "fk_refunds_payment"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_refunds_payment_id"`);
    await queryRunner.query(
      `DROP INDEX "public"."uq_refunds_provider_reference"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_refunds_requested_by_idempotency_key"`,
    );
    await queryRunner.query(`DROP INDEX "public"."uq_refunds_transaction_id"`);
    await queryRunner.query(`DROP INDEX "public"."uq_refunds_reference"`);
    await queryRunner.query(`DROP TABLE "refunds"`);
  }
}
