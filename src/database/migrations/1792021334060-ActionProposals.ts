import { MigrationInterface, QueryRunner } from 'typeorm';

export class ActionProposals1792021334060 implements MigrationInterface {
  name = 'ActionProposals1792021334060';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "action_proposals" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL, "kind" character varying(20) NOT NULL, "params" jsonb NOT NULL, "summary" character varying(300) NOT NULL, "reasoning" text NOT NULL, "evidence" jsonb, "status" character varying(20) NOT NULL DEFAULT 'pending', "proposed_by_api_key_id" uuid, "proposed_by_user_id" uuid, "decided_by_user_id" uuid, "decided_at" TIMESTAMP(3) WITH TIME ZONE, "decision_note" character varying(500), "result" jsonb, "failure_reason" character varying(500), "expires_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_action_proposals_decided" CHECK (("status" = 'pending') = ("decided_at" IS NULL)), CONSTRAINT "chk_action_proposals_status" CHECK ("status" IN ('pending', 'rejected', 'executed', 'failed', 'expired')), CONSTRAINT "chk_action_proposals_kind" CHECK ("kind" IN ('payout')), CONSTRAINT "pk_action_proposals" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_action_proposals_org_status" ON "action_proposals"  ("organization_id", "status", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "action_proposals" ADD CONSTRAINT "fk_action_proposals_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "action_proposals" DROP CONSTRAINT "fk_action_proposals_organization"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_action_proposals_org_status"`,
    );
    await queryRunner.query(`DROP TABLE "action_proposals"`);
  }
}
