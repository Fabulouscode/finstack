import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOutbox1790285667070 implements MigrationInterface {
  name = 'CreateOutbox1790285667070';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "outbox_events" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "type" character varying(100) NOT NULL, "aggregate_type" character varying(50) NOT NULL, "aggregate_id" uuid NOT NULL, "payload" jsonb NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'pending', "publish_attempts" integer NOT NULL DEFAULT '0', "last_error" character varying(1000), "available_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "published_at" TIMESTAMP(3) WITH TIME ZONE, CONSTRAINT "chk_outbox_events_status" CHECK ("status" IN ('pending', 'published')), CONSTRAINT "pk_outbox_events" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_outbox_events_pending" ON "outbox_events"  ("available_at", "created_at") WHERE "status" = 'pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_outbox_events_pending"`);
    await queryRunner.query(`DROP TABLE "outbox_events"`);
  }
}
