import { MigrationInterface, QueryRunner } from 'typeorm';

/** Payout destinations (saved bank accounts) and payouts. */
export class CreatePayouts1790345933843 implements MigrationInterface {
  name = 'CreatePayouts1790345933843';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "payout_destinations" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid, "organization_id" uuid, "provider" character varying(50) NOT NULL, "currency" character(3) NOT NULL, "recipient_reference" character varying(100) NOT NULL, "bank_code" character varying(20) NOT NULL, "bank_name" character varying(200), "account_name" character varying(200) NOT NULL, "account_number_last4" character varying(4) NOT NULL, "label" character varying(100), "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "removed_at" TIMESTAMP(3) WITH TIME ZONE, CONSTRAINT "chk_payout_destinations_currency" CHECK ("currency" ~ '^[A-Z]{3}$'), CONSTRAINT "chk_payout_destinations_owner" CHECK (num_nonnulls("user_id", "organization_id") = 1), CONSTRAINT "pk_payout_destinations" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payout_destinations_org_recipient" ON "payout_destinations"  ("organization_id", "provider", "recipient_reference") WHERE "organization_id" IS NOT NULL AND "removed_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payout_destinations_user_recipient" ON "payout_destinations"  ("user_id", "provider", "recipient_reference") WHERE "user_id" IS NOT NULL AND "removed_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "payouts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "reference" character varying(64) NOT NULL, "transaction_id" uuid NOT NULL, "user_id" uuid, "organization_id" uuid, "wallet_id" uuid NOT NULL, "destination_id" uuid NOT NULL, "provider" character varying(50) NOT NULL, "amount" bigint NOT NULL, "currency" character(3) NOT NULL, "narration" character varying(100), "provider_reference" character varying(255), "submitted_at" TIMESTAMP(3) WITH TIME ZONE, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "REL_18b1b9fbdcac20fb5447b6d96e" UNIQUE ("transaction_id"), CONSTRAINT "chk_payouts_amount_positive" CHECK ("amount" > 0), CONSTRAINT "chk_payouts_owner" CHECK (num_nonnulls("user_id", "organization_id") = 1), CONSTRAINT "pk_payouts" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payouts_reference" ON "payouts"  ("reference") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payouts_transaction_id" ON "payouts"  ("transaction_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payouts_org_created" ON "payouts"  ("organization_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payouts_user_created" ON "payouts"  ("user_id", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" ADD CONSTRAINT "fk_payout_destinations_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" ADD CONSTRAINT "fk_payout_destinations_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payouts" ADD CONSTRAINT "fk_payouts_transaction" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payouts" ADD CONSTRAINT "fk_payouts_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payouts" ADD CONSTRAINT "fk_payouts_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payouts" ADD CONSTRAINT "fk_payouts_wallet" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payouts" ADD CONSTRAINT "fk_payouts_destination" FOREIGN KEY ("destination_id") REFERENCES "payout_destinations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payouts" DROP CONSTRAINT "fk_payouts_destination"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payouts" DROP CONSTRAINT "fk_payouts_wallet"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payouts" DROP CONSTRAINT "fk_payouts_organization"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payouts" DROP CONSTRAINT "fk_payouts_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payouts" DROP CONSTRAINT "fk_payouts_transaction"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" DROP CONSTRAINT "fk_payout_destinations_organization"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" DROP CONSTRAINT "fk_payout_destinations_user"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_payouts_user_created"`);
    await queryRunner.query(`DROP INDEX "public"."idx_payouts_org_created"`);
    await queryRunner.query(`DROP INDEX "public"."uq_payouts_transaction_id"`);
    await queryRunner.query(`DROP INDEX "public"."uq_payouts_reference"`);
    await queryRunner.query(`DROP TABLE "payouts"`);
    await queryRunner.query(
      `DROP INDEX "public"."uq_payout_destinations_user_recipient"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_payout_destinations_org_recipient"`,
    );
    await queryRunner.query(`DROP TABLE "payout_destinations"`);
  }
}
