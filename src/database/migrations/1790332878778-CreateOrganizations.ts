import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrganizations1790332878778 implements MigrationInterface {
  name = 'CreateOrganizations1790332878778';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "organizations" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "name" character varying(200) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'active', "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_organizations_status" CHECK ("status" IN ('active', 'suspended')), CONSTRAINT "pk_organizations" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "organization_members" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL, "user_id" uuid NOT NULL, "role" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_organization_members_role" CHECK ("role" IN ('owner', 'admin', 'member', 'viewer')), CONSTRAINT "pk_organization_members" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_organization_members_user_id" ON "organization_members"  ("user_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_organization_members_owner" ON "organization_members"  ("organization_id") WHERE "role" = 'owner'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_organization_members_org_user" ON "organization_members"  ("organization_id", "user_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_members" ADD CONSTRAINT "fk_organization_members_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_members" ADD CONSTRAINT "fk_organization_members_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organization_members" DROP CONSTRAINT "fk_organization_members_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_members" DROP CONSTRAINT "fk_organization_members_organization"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_organization_members_org_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_organization_members_owner"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_organization_members_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "organization_members"`);
    await queryRunner.query(`DROP TABLE "organizations"`);
  }
}
