export enum LedgerAccountType {
  Asset = 'asset',
  Liability = 'liability',
  Equity = 'equity',
  Revenue = 'revenue',
  Expense = 'expense',
}

export enum EntryDirection {
  Debit = 'debit',
  Credit = 'credit',
}

/**
 * The side on which an account type increases. Assets and expenses grow with
 * debits; liabilities, equity and revenue grow with credits.
 */
export function normalBalanceFor(type: LedgerAccountType): EntryDirection {
  return type === LedgerAccountType.Asset || type === LedgerAccountType.Expense
    ? EntryDirection.Debit
    : EntryDirection.Credit;
}

export const sqlList = (values: string[]): string =>
  values.map((value) => `'${value}'`).join(', ');
