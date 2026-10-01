import { MigrationInterface, QueryRunner } from 'typeorm';

export class RefundSubmissions1790876006181 implements MigrationInterface {
  name = 'RefundSubmissions1790876006181';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refunds" ADD "submitted_at" TIMESTAMP(3) WITH TIME ZONE`,
    );
    // Every existing refund was sent when it was created. Without this, a
    // refund already stuck in processing would look never-sent and be sent
    // again without asking the provider first.
    await queryRunner.query(
      `UPDATE "refunds" SET "submitted_at" = "created_at"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "refunds" DROP COLUMN "submitted_at"`);
  }
}
