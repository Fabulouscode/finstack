import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateApiKeys1790333269747 implements MigrationInterface {
  name = 'CreateApiKeys1790333269747';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "api_keys" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL, "name" character varying(100) NOT NULL, "prefix" character varying(40) NOT NULL, "key_hash" character(64) NOT NULL, "scopes" character varying(50) array NOT NULL, "created_by_user_id" uuid, "last_used_at" TIMESTAMP(3) WITH TIME ZONE, "expires_at" TIMESTAMP(3) WITH TIME ZONE, "revoked_at" TIMESTAMP(3) WITH TIME ZONE, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_api_keys_scopes_not_empty" CHECK (cardinality("scopes") > 0), CONSTRAINT "pk_api_keys" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_api_keys_prefix" ON "api_keys"  ("prefix") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_api_keys_key_hash" ON "api_keys"  ("key_hash") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_api_keys_organization_id" ON "api_keys"  ("organization_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "api_keys" ADD CONSTRAINT "fk_api_keys_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_keys" ADD CONSTRAINT "fk_api_keys_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "api_keys" DROP CONSTRAINT "fk_api_keys_created_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_keys" DROP CONSTRAINT "fk_api_keys_organization"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_api_keys_organization_id"`,
    );
    await queryRunner.query(`DROP INDEX "public"."uq_api_keys_key_hash"`);
    await queryRunner.query(`DROP INDEX "public"."uq_api_keys_prefix"`);
    await queryRunner.query(`DROP TABLE "api_keys"`);
  }
}
