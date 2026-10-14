import { MigrationInterface, QueryRunner } from 'typeorm';

export class PayPalPayoutDestinations1792019122181 implements MigrationInterface {
  name = 'PayPalPayoutDestinations1792019122181';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" ADD "kind" character varying(10) NOT NULL DEFAULT 'bank'`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" ADD "email" character varying(254)`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" ALTER COLUMN "bank_code" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" ALTER COLUMN "account_number_last4" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" ADD CONSTRAINT "chk_payout_destinations_kind" CHECK (("kind" = 'bank' AND "bank_code" IS NOT NULL AND "account_number_last4" IS NOT NULL) OR ("kind" = 'paypal' AND "email" IS NOT NULL))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" DROP CONSTRAINT "chk_payout_destinations_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" ALTER COLUMN "account_number_last4" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" ALTER COLUMN "bank_code" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" DROP COLUMN "email"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_destinations" DROP COLUMN "kind"`,
    );
  }
}
