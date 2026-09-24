import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePaymentsAndWebhooks1790284785946 implements MigrationInterface {
  name = 'CreatePaymentsAndWebhooks1790284785946';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "transaction_id" uuid NOT NULL, "user_id" uuid NOT NULL, "wallet_id" uuid NOT NULL, "provider" character varying(50) NOT NULL, "provider_reference" character varying(255), "authorization_url" character varying(2048), "amount" bigint NOT NULL, "currency" character(3) NOT NULL, "fx_quote_id" uuid, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "REL_3c324ca49dabde7ffc0ef64675" UNIQUE ("transaction_id"), CONSTRAINT "pk_payments" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payments_transaction_id" ON "payments"  ("transaction_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payments_user_created" ON "payments"  ("user_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payments_provider_reference" ON "payments"  ("provider", "provider_reference") WHERE "provider_reference" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "webhook_events" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "provider" character varying(50) NOT NULL, "event_id" character varying(255) NOT NULL, "type" character varying(100) NOT NULL, "provider_type" character varying(100) NOT NULL, "provider_reference" character varying(255), "payload" jsonb NOT NULL, "status" character varying(20) NOT NULL, "outcome" character varying(50), "attempts" integer NOT NULL DEFAULT '0', "last_error" character varying(1000), "received_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "processed_at" TIMESTAMP(3) WITH TIME ZONE, CONSTRAINT "chk_webhook_events_status" CHECK ("status" IN ('received', 'processed', 'failed', 'ignored')), CONSTRAINT "pk_webhook_events" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_webhook_events_status_received" ON "webhook_events"  ("status", "received_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_webhook_events_provider_event" ON "webhook_events"  ("provider", "event_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "fk_payments_transaction" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "fk_payments_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "fk_payments_wallet" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "fk_payments_fx_quote" FOREIGN KEY ("fx_quote_id") REFERENCES "fx_quotes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "fk_payments_fx_quote"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "fk_payments_wallet"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "fk_payments_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "fk_payments_transaction"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_webhook_events_provider_event"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_webhook_events_status_received"`,
    );
    await queryRunner.query(`DROP TABLE "webhook_events"`);
    await queryRunner.query(
      `DROP INDEX "public"."uq_payments_provider_reference"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_payments_user_created"`);
    await queryRunner.query(`DROP INDEX "public"."uq_payments_transaction_id"`);
    await queryRunner.query(`DROP TABLE "payments"`);
  }
}
