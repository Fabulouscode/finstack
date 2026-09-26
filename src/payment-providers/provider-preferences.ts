/**
 * FinStack's suggested provider per currency: local African currencies
 * through Paystack, international ones through Stripe. A suggestion only
 * applies when that provider is enabled and can charge the currency, and
 * never overrides an operator's PAYMENT_CURRENCY_ROUTES or a provider the
 * client asked for. Businesses with other providers or contracts keep full
 * control.
 */
export const PROVIDER_PREFERENCES: Readonly<Record<string, string>> = {
  NGN: 'paystack',
  GHS: 'paystack',
  KES: 'paystack',
  ZAR: 'paystack',
  USD: 'stripe',
  EUR: 'stripe',
  GBP: 'stripe',
  JPY: 'stripe',
};
