import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateIdempotencyAndTransactions1790274438167 implements MigrationInterface {
  name = 'CreateIdempotencyAndTransactions1790274438167';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "idempotency_keys" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "key" character varying(255) NOT NULL, "method" character varying(10) NOT NULL, "path" character varying(500) NOT NULL, "request_hash" character(64) NOT NULL, "status" character varying(20) NOT NULL, "response_status" integer, "response_body" jsonb, "locked_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL, "expires_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "completed_at" TIMESTAMP(3) WITH TIME ZONE, CONSTRAINT "chk_idempotency_keys_response_when_completed" CHECK (("status" = 'completed') = ("response_status" IS NOT NULL)), CONSTRAINT "chk_idempotency_keys_status" CHECK ("status" IN ('processing', 'completed')), CONSTRAINT "pk_idempotency_keys" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_idempotency_keys_expires_at" ON "idempotency_keys"  ("expires_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_idempotency_keys_user_key" ON "idempotency_keys"  ("user_id", "key") `,
    );
    await queryRunner.query(
      `CREATE TABLE "transactions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "reference" character varying(64) NOT NULL, "type" character varying(20) NOT NULL, "status" character varying(20) NOT NULL, "user_id" uuid NOT NULL, "counterparty_user_id" uuid, "source_wallet_id" uuid, "destination_wallet_id" uuid, "amount" bigint NOT NULL, "currency" character(3) NOT NULL, "ledger_transaction_id" uuid, "provider_reference" character varying(255), "idempotency_key" character varying(255), "description" character varying(500), "failure_code" character varying(100), "failure_reason" character varying(500), "metadata" jsonb NOT NULL DEFAULT '{}', "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "completed_at" TIMESTAMP(3) WITH TIME ZONE, CONSTRAINT "chk_transactions_successful_has_ledger" CHECK ("status" NOT IN ('successful', 'reversed') OR "ledger_transaction_id" IS NOT NULL), CONSTRAINT "chk_transactions_currency" CHECK ("currency" ~ '^[A-Z]{3}$'), CONSTRAINT "chk_transactions_amount_positive" CHECK ("amount" > 0), CONSTRAINT "chk_transactions_status" CHECK ("status" IN ('pending', 'processing', 'successful', 'failed', 'reversed', 'cancelled', 'expired')), CONSTRAINT "chk_transactions_type" CHECK ("type" IN ('transfer', 'deposit', 'withdrawal', 'payment', 'refund', 'fee', 'reversal', 'conversion')), CONSTRAINT "pk_transactions" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_transactions_reference" ON "transactions"  ("reference") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_transactions_counterparty_created_id" ON "transactions"  ("counterparty_user_id", "created_at", "id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_transactions_user_created_id" ON "transactions"  ("user_id", "created_at", "id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_transactions_user_idempotency_key" ON "transactions"  ("user_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ADD CONSTRAINT "fk_idempotency_keys_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "fk_transactions_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "fk_transactions_counterparty_user" FOREIGN KEY ("counterparty_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "fk_transactions_source_wallet" FOREIGN KEY ("source_wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "fk_transactions_destination_wallet" FOREIGN KEY ("destination_wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "fk_transactions_ledger_transaction" FOREIGN KEY ("ledger_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP CONSTRAINT "fk_transactions_ledger_transaction"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP CONSTRAINT "fk_transactions_destination_wallet"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP CONSTRAINT "fk_transactions_source_wallet"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP CONSTRAINT "fk_transactions_counterparty_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP CONSTRAINT "fk_transactions_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" DROP CONSTRAINT "fk_idempotency_keys_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_transactions_user_idempotency_key"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_transactions_user_created_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_transactions_counterparty_created_id"`,
    );
    await queryRunner.query(`DROP INDEX "public"."uq_transactions_reference"`);
    await queryRunner.query(`DROP TABLE "transactions"`);
    await queryRunner.query(
      `DROP INDEX "public"."uq_idempotency_keys_user_key"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_idempotency_keys_expires_at"`,
    );
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
  }
}
