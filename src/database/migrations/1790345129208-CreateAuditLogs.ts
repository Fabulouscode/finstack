import { MigrationInterface, QueryRunner } from 'typeorm';

/** Append-only audit trail of sensitive and administrative actions. */
export class CreateAuditLogs1790345129208 implements MigrationInterface {
  name = 'CreateAuditLogs1790345129208';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "audit_logs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "actor_type" character varying(20) NOT NULL, "actor_id" uuid, "organization_id" uuid, "action" character varying(100) NOT NULL, "target_type" character varying(50) NOT NULL, "target_id" character varying(100) NOT NULL, "metadata" jsonb NOT NULL DEFAULT '{}', "request_id" character varying(128), "ip_address" character varying(64), "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_audit_logs_actor_id" CHECK (("actor_type" = 'system') = ("actor_id" IS NULL)), CONSTRAINT "chk_audit_logs_actor_type" CHECK ("actor_type" IN ('user', 'api_key', 'system')), CONSTRAINT "pk_audit_logs" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_target" ON "audit_logs"  ("target_type", "target_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_actor_created" ON "audit_logs"  ("actor_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_org_created_id" ON "audit_logs"  ("organization_id", "created_at", "id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_created_id" ON "audit_logs"  ("created_at", "id") `,
    );

    // Append-only: the trail can't be edited or erased through the database.
    await queryRunner.query(`
      CREATE FUNCTION audit_logs_prevent_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'audit log rows are immutable: % is not allowed', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_immutable
      BEFORE UPDATE OR DELETE ON "audit_logs"
      FOR EACH ROW EXECUTE FUNCTION audit_logs_prevent_mutation()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER "trg_audit_logs_immutable" ON "audit_logs"`,
    );
    await queryRunner.query(`DROP FUNCTION audit_logs_prevent_mutation()`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_created_id"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_audit_logs_org_created_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_audit_logs_actor_created"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_target"`);
    await queryRunner.query(`DROP TABLE "audit_logs"`);
  }
}
