import { ConfigValidationError } from './validate-config';
import { walletsConfig } from './wallets.config';

describe('walletsConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {};
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('defaults to USD only: users cannot choose', () => {
    expect(walletsConfig()).toEqual({
      defaultCurrency: 'USD',
      allowedCurrencies: ['USD'],
    });
  });

  it('lets the operator pick another single base currency', () => {
    process.env.DEFAULT_WALLET_CURRENCY = 'NGN';

    expect(walletsConfig()).toEqual({
      defaultCurrency: 'NGN',
      allowedCurrencies: ['NGN'],
    });
  });

  it('lets the operator offer a choice of base currencies', () => {
    process.env.ALLOWED_WALLET_CURRENCIES = 'USD, EUR,GBP,USD';

    expect(walletsConfig().allowedCurrencies).toEqual(['USD', 'EUR', 'GBP']);
  });

  it('requires the default to be one of the allowed currencies', () => {
    process.env.ALLOWED_WALLET_CURRENCIES = 'EUR,GBP';

    expect(() => walletsConfig()).toThrow(
      /must include DEFAULT_WALLET_CURRENCY/,
    );
  });

  it.each([
    ['DEFAULT_WALLET_CURRENCY', 'XXX'],
    ['ALLOWED_WALLET_CURRENCIES', 'USD,XXX'],
    ['ALLOWED_WALLET_CURRENCIES', ' , '],
  ])('rejects %s=%p', (name, value) => {
    process.env[name] = value;

    expect(() => walletsConfig()).toThrow(ConfigValidationError);
  });
});
