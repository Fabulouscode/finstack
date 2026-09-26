import { MigrationInterface, QueryRunner } from 'typeorm';

/** Record of notification emails, so each is sent once. */
export class CreateEmailNotifications1790425656405 implements MigrationInterface {
  name = 'CreateEmailNotifications1790425656405';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "email_notifications" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "event_id" uuid NOT NULL, "template" character varying(50) NOT NULL, "recipient_user_id" uuid NOT NULL, "to_email" character varying(320) NOT NULL, "subject" character varying(200) NOT NULL, "status" character varying(20) NOT NULL, "attempts" integer NOT NULL DEFAULT '0', "last_error" character varying(1000), "sent_at" TIMESTAMP(3) WITH TIME ZONE, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_email_notifications_status" CHECK ("status" IN ('pending', 'sent', 'failed')), CONSTRAINT "pk_email_notifications" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_email_notifications_recipient_created" ON "email_notifications"  ("recipient_user_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_email_notifications_event_template_recipient" ON "email_notifications"  ("event_id", "template", "recipient_user_id") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."uq_email_notifications_event_template_recipient"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_email_notifications_recipient_created"`,
    );
    await queryRunner.query(`DROP TABLE "email_notifications"`);
  }
}
