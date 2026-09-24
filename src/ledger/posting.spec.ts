import { InvalidPostingError } from './ledger.errors';
import {
  EntryDirection,
  LedgerAccountType,
  normalBalanceFor,
} from './ledger.types';
import { entriesFingerprint, PostingInput, validatePosting } from './posting';

const { Debit, Credit } = EntryDirection;

function posting(
  entries: PostingInput['entries'],
  overrides: Partial<PostingInput> = {},
): PostingInput {
  return {
    reference: 'ref-1',
    description: 'Test',
    currency: 'NGN',
    entries,
    ...overrides,
  };
}

describe('validatePosting', () => {
  it('returns the transaction amount for a balanced posting', () => {
    expect(
      validatePosting(
        posting([
          { accountId: 'a', direction: Debit, amount: 1_000_000n },
          { accountId: 'b', direction: Credit, amount: 700_000n },
          { accountId: 'c', direction: Credit, amount: 300_000n },
        ]),
      ),
    ).toBe(1_000_000n);
  });

  it.each([
    [
      'unbalanced',
      [
        { accountId: 'a', direction: Debit, amount: 100n },
        { accountId: 'b', direction: Credit, amount: 99n },
      ],
    ],
    ['a single entry', [{ accountId: 'a', direction: Debit, amount: 100n }]],
    [
      'debits only',
      [
        { accountId: 'a', direction: Debit, amount: 100n },
        { accountId: 'b', direction: Debit, amount: 100n },
      ],
    ],
    [
      'a zero amount',
      [
        { accountId: 'a', direction: Debit, amount: 0n },
        { accountId: 'b', direction: Credit, amount: 0n },
      ],
    ],
    [
      'a negative amount',
      [
        { accountId: 'a', direction: Debit, amount: -5n },
        { accountId: 'b', direction: Credit, amount: -5n },
      ],
    ],
  ] as const)('rejects %s', (_label, entries) => {
    expect(() => validatePosting(posting([...entries]))).toThrow(
      InvalidPostingError,
    );
  });

  it('rejects non-bigint amounts (floating point never reaches the ledger)', () => {
    const entries = [
      { accountId: 'a', direction: Debit, amount: 10.5 as unknown as bigint },
      { accountId: 'b', direction: Credit, amount: 10.5 as unknown as bigint },
    ];
    expect(() => validatePosting(posting(entries))).toThrow(
      InvalidPostingError,
    );
  });

  it('rejects unsupported currencies and bad references', () => {
    const entries = [
      { accountId: 'a', direction: Debit, amount: 1n },
      { accountId: 'b', direction: Credit, amount: 1n },
    ];
    expect(() =>
      validatePosting(posting(entries, { currency: 'XXX' })),
    ).toThrow(InvalidPostingError);
    expect(() =>
      validatePosting(posting(entries, { reference: '  ' })),
    ).toThrow(InvalidPostingError);
    expect(() =>
      validatePosting(posting(entries, { reference: 'x'.repeat(256) })),
    ).toThrow(InvalidPostingError);
  });
});

describe('entriesFingerprint', () => {
  it('is independent of entry order', () => {
    const a = { accountId: 'a', direction: Debit, amount: 5n };
    const b = { accountId: 'b', direction: Credit, amount: 5n };

    expect(entriesFingerprint([a, b])).toBe(entriesFingerprint([b, a]));
    expect(entriesFingerprint([a, b])).not.toBe(
      entriesFingerprint([a, { ...b, amount: 6n }]),
    );
  });
});

describe('normalBalanceFor', () => {
  it.each([
    [LedgerAccountType.Asset, Debit],
    [LedgerAccountType.Expense, Debit],
    [LedgerAccountType.Liability, Credit],
    [LedgerAccountType.Equity, Credit],
    [LedgerAccountType.Revenue, Credit],
  ])('%s accounts increase with %s', (type, side) => {
    expect(normalBalanceFor(type)).toBe(side);
  });
});
