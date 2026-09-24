import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Database-level guarantees for the ledger. They hold even if application
 * code has a bug, a script bypasses the service layer, or requests race:
 *
 * 1. Ledger transactions and entries are immutable (no UPDATE/DELETE).
 * 2. An entry's currency matches its account and its transaction.
 * 3. Account balances change only as a side effect of inserting entries.
 * 4. Every transaction is balanced (debits = credits = amount, >= 2 entries),
 *    checked at COMMIT by deferred constraint triggers.
 *
 * Overdrafts are prevented by chk_ledger_accounts_non_negative, which fires
 * when trigger 3 applies an entry.
 */
export class AddLedgerIntegrityTriggers1790267201855 implements MigrationInterface {
  name = 'AddLedgerIntegrityTriggers1790267201855';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Immutability
    await queryRunner.query(`
      CREATE FUNCTION ledger_prevent_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'ledger rows are immutable: % on % is not allowed', TG_OP, TG_TABLE_NAME
          USING HINT = 'Post a reversal instead of editing ledger history.';
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_ledger_transactions_immutable
      BEFORE UPDATE OR DELETE ON ledger_transactions
      FOR EACH ROW EXECUTE FUNCTION ledger_prevent_mutation()
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_ledger_entries_immutable
      BEFORE UPDATE OR DELETE ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION ledger_prevent_mutation()
    `);

    // 2. Currency consistency
    await queryRunner.query(`
      CREATE FUNCTION ledger_entries_check_currency() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        account_currency char(3);
        transaction_currency char(3);
      BEGIN
        SELECT currency INTO account_currency FROM ledger_accounts WHERE id = NEW.ledger_account_id;
        SELECT currency INTO transaction_currency FROM ledger_transactions WHERE id = NEW.ledger_transaction_id;
        IF NEW.currency IS DISTINCT FROM account_currency
           OR NEW.currency IS DISTINCT FROM transaction_currency THEN
          RAISE EXCEPTION 'ledger entry currency % does not match account (%) or transaction (%)',
            NEW.currency, account_currency, transaction_currency;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_ledger_entries_check_currency
      BEFORE INSERT ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION ledger_entries_check_currency()
    `);

    // 3. Balances move only through entries
    await queryRunner.query(`
      CREATE FUNCTION ledger_entries_apply_balance() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE ledger_accounts
           SET balance = balance + CASE WHEN normal_balance = NEW.direction
                                        THEN NEW.amount ELSE -NEW.amount END,
               updated_at = now()
         WHERE id = NEW.ledger_account_id;
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_ledger_entries_apply_balance
      AFTER INSERT ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION ledger_entries_apply_balance()
    `);
    await queryRunner.query(`
      CREATE FUNCTION ledger_accounts_guard_balance() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.balance <> 0 THEN
          RAISE EXCEPTION 'ledger accounts must be created with a zero balance';
        END IF;
        -- Depth 1 is a direct UPDATE; depth 2 is the update issued by
        -- ledger_entries_apply_balance, the only allowed path.
        IF TG_OP = 'UPDATE' AND NEW.balance IS DISTINCT FROM OLD.balance
           AND pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'ledger_accounts.balance can only change by posting ledger entries';
        END IF;
        IF TG_OP = 'UPDATE' AND (NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.normal_balance IS DISTINCT FROM OLD.normal_balance) THEN
          RAISE EXCEPTION 'ledger account currency and normal balance are immutable';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_ledger_accounts_guard_balance
      BEFORE INSERT OR UPDATE ON ledger_accounts
      FOR EACH ROW EXECUTE FUNCTION ledger_accounts_guard_balance()
    `);

    // 4. Balanced transactions, verified at COMMIT
    await queryRunner.query(`
      CREATE FUNCTION ledger_check_transaction_balanced() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        transaction_id uuid;
        transaction_amount bigint;
        entry_count integer;
        debits numeric;
        credits numeric;
      BEGIN
        IF TG_TABLE_NAME = 'ledger_transactions' THEN
          transaction_id := NEW.id;
        ELSE
          transaction_id := NEW.ledger_transaction_id;
        END IF;

        SELECT amount INTO transaction_amount FROM ledger_transactions WHERE id = transaction_id;
        SELECT count(*),
               COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0),
               COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
          INTO entry_count, debits, credits
          FROM ledger_entries
         WHERE ledger_transaction_id = transaction_id;

        IF entry_count < 2 OR debits <> credits OR debits <> transaction_amount THEN
          RAISE EXCEPTION 'ledger transaction % is unbalanced: % entries, debits %, credits %, amount %',
            transaction_id, entry_count, debits, credits, transaction_amount;
        END IF;
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER trg_ledger_transactions_balanced
      AFTER INSERT ON ledger_transactions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ledger_check_transaction_balanced()
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER trg_ledger_entries_balanced
      AFTER INSERT ON ledger_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ledger_check_transaction_balanced()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TRIGGER trg_ledger_entries_balanced ON ledger_entries',
    );
    await queryRunner.query(
      'DROP TRIGGER trg_ledger_transactions_balanced ON ledger_transactions',
    );
    await queryRunner.query(
      'DROP FUNCTION ledger_check_transaction_balanced()',
    );
    await queryRunner.query(
      'DROP TRIGGER trg_ledger_accounts_guard_balance ON ledger_accounts',
    );
    await queryRunner.query('DROP FUNCTION ledger_accounts_guard_balance()');
    await queryRunner.query(
      'DROP TRIGGER trg_ledger_entries_apply_balance ON ledger_entries',
    );
    await queryRunner.query('DROP FUNCTION ledger_entries_apply_balance()');
    await queryRunner.query(
      'DROP TRIGGER trg_ledger_entries_check_currency ON ledger_entries',
    );
    await queryRunner.query('DROP FUNCTION ledger_entries_check_currency()');
    await queryRunner.query(
      'DROP TRIGGER trg_ledger_entries_immutable ON ledger_entries',
    );
    await queryRunner.query(
      'DROP TRIGGER trg_ledger_transactions_immutable ON ledger_transactions',
    );
    await queryRunner.query('DROP FUNCTION ledger_prevent_mutation()');
  }
}
