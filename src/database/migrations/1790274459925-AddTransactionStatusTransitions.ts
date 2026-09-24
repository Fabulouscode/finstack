import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enforces the transaction state machine in the database, mirroring
 * TRANSACTION_TRANSITIONS in src/transactions/transaction.types.ts. An
 * integration test tries every (from, to) pair against both, so they can't
 * drift apart silently.
 */
export class AddTransactionStatusTransitions1790274459925 implements MigrationInterface {
  name = 'AddTransactionStatusTransitions1790274459925';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION transactions_check_status_transition() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
          RETURN NEW;
        END IF;
        IF NOT (
             (OLD.status = 'pending'    AND NEW.status IN ('processing', 'successful', 'failed', 'cancelled', 'expired'))
          OR (OLD.status = 'processing' AND NEW.status IN ('successful', 'failed'))
          OR (OLD.status = 'successful' AND NEW.status = 'reversed')
        ) THEN
          RAISE EXCEPTION 'invalid transaction status transition: % -> %', OLD.status, NEW.status
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_transactions_status_transition
      BEFORE UPDATE OF status ON transactions
      FOR EACH ROW EXECUTE FUNCTION transactions_check_status_transition()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TRIGGER trg_transactions_status_transition ON transactions',
    );
    await queryRunner.query(
      'DROP FUNCTION transactions_check_status_transition()',
    );
  }
}
