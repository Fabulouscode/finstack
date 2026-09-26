import { MigrationInterface, QueryRunner } from 'typeorm';

/** Outbound webhooks: organizations' endpoints and their deliveries. */
export class CreateWebhookEndpoints1790424269586 implements MigrationInterface {
  name = 'CreateWebhookEndpoints1790424269586';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "webhook_endpoints" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL, "url" character varying(2048) NOT NULL, "description" character varying(200), "event_types" character varying(50) array NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "disabled_reason" character varying(200), "secret_sealed" character varying(500) NOT NULL, "previous_secret_sealed" character varying(500), "previous_secret_expires_at" TIMESTAMP(3) WITH TIME ZONE, "consecutive_failures" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3) WITH TIME ZONE, CONSTRAINT "chk_webhook_endpoints_event_types" CHECK (cardinality("event_types") > 0), CONSTRAINT "pk_webhook_endpoints" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_webhook_endpoints_org" ON "webhook_endpoints"  ("organization_id") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "webhook_deliveries" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "endpoint_id" uuid NOT NULL, "event_id" uuid NOT NULL, "event_type" character varying(100) NOT NULL, "payload" jsonb NOT NULL, "status" character varying(20) NOT NULL, "attempts" integer NOT NULL DEFAULT '0', "last_response_status" integer, "last_error" character varying(1000), "last_attempt_at" TIMESTAMP(3) WITH TIME ZONE, "delivered_at" TIMESTAMP(3) WITH TIME ZONE, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_webhook_deliveries_status" CHECK ("status" IN ('pending', 'succeeded', 'failed')), CONSTRAINT "pk_webhook_deliveries" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_webhook_deliveries_endpoint_created_id" ON "webhook_deliveries"  ("endpoint_id", "created_at", "id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_webhook_deliveries_endpoint_event" ON "webhook_deliveries"  ("endpoint_id", "event_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "fk_webhook_endpoints_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "fk_webhook_deliveries_endpoint" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "fk_webhook_deliveries_endpoint"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "fk_webhook_endpoints_organization"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_webhook_deliveries_endpoint_event"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_webhook_deliveries_endpoint_created_id"`,
    );
    await queryRunner.query(`DROP TABLE "webhook_deliveries"`);
    await queryRunner.query(`DROP INDEX "public"."idx_webhook_endpoints_org"`);
    await queryRunner.query(`DROP TABLE "webhook_endpoints"`);
  }
}
