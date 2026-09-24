import { SnakeNamingStrategy } from './snake-naming.strategy';

describe('SnakeNamingStrategy', () => {
  const strategy = new SnakeNamingStrategy();

  it('snake_cases table names unless explicitly named', () => {
    expect(strategy.tableName('LedgerEntry', undefined)).toBe('ledger_entry');
    expect(strategy.tableName('LedgerEntry', 'ledger_entries')).toBe(
      'ledger_entries',
    );
  });

  it('snake_cases column names', () => {
    expect(strategy.columnName('availableBalance', undefined, [])).toBe(
      'available_balance',
    );
  });

  it('keeps explicitly named columns as given', () => {
    expect(strategy.columnName('amount', 'amount_minor', [])).toBe(
      'amount_minor',
    );
  });

  it('prefixes embedded columns', () => {
    expect(strategy.columnName('amount', undefined, ['money'])).toBe(
      'money_amount',
    );
  });

  it('snake_cases join columns', () => {
    expect(strategy.joinColumnName('ledgerAccount', 'id')).toBe(
      'ledger_account_id',
    );
  });

  it('snake_cases join tables and join table columns', () => {
    expect(strategy.joinTableName('user', 'role', 'userRoles')).toBe(
      'user_user_roles_role',
    );
    expect(strategy.joinTableColumnName('user', 'id')).toBe('user_id');
  });
});
