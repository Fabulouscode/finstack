import { LedgerAccountType } from './ledger.types';

export interface SystemAccountDefinition {
  code: string;
  name: string;
  type: LedgerAccountType;
  currency: string;
  allowNegativeBalance?: boolean;
}

/**
 * The platform's own ledger accounts, one per currency, created on first
 * use. Defined once so every module posts to the same accounts.
 */
export const SystemAccounts = {
  /** Money held at payment providers and banks; may go negative while settlements are in flight. */
  externalClearing: (currency: string): SystemAccountDefinition => ({
    code: `system:external-clearing:${currency}`,
    name: `External clearing (${currency})`,
    type: LedgerAccountType.Asset,
    currency,
    allowNegativeBalance: true,
  }),

  /** Each currency's side of FX conversions: the platform's open FX exposure. */
  fxPosition: (currency: string): SystemAccountDefinition => ({
    code: `system:fx-position:${currency}`,
    name: `FX position (${currency})`,
    type: LedgerAccountType.Asset,
    currency,
    allowNegativeBalance: true,
  }),

  /** Fees charged on payments, payouts and transfers. */
  feeRevenue: (currency: string): SystemAccountDefinition => ({
    code: `system:fee-revenue:${currency}`,
    name: `Fee revenue (${currency})`,
    type: LedgerAccountType.Revenue,
    currency,
  }),

  /** Spread earned on conversions. */
  fxRevenue: (currency: string): SystemAccountDefinition => ({
    code: `system:fx-revenue:${currency}`,
    name: `FX revenue (${currency})`,
    type: LedgerAccountType.Revenue,
    currency,
  }),
} as const;
