import { EventSource, FetchFn } from './event-source';
import { FlutterwaveSource } from './flutterwave-source';
import { PaystackSource } from './paystack-source';
import { StripeSource } from './stripe-source';

export const LISTENABLE_PROVIDERS = ['paystack', 'stripe', 'flutterwave'];

type Env = Record<string, string | undefined>;

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * The sources to listen to: the requested providers (or every enabled one
 * in PAYMENT_PROVIDERS), each with its settings checked. Test keys only:
 * this is a development tool.
 */
export function buildSources(
  env: Env,
  requested: string[],
  fetchFn: FetchFn,
): { sources: EventSource[]; problems: string[] } {
  const enabled = (env.PAYMENT_PROVIDERS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => LISTENABLE_PROVIDERS.includes(name));
  const names = requested.length > 0 ? requested : enabled;
  const sources: EventSource[] = [];
  const problems: string[] = [];

  for (const name of names) {
    if (!LISTENABLE_PROVIDERS.includes(name)) {
      problems.push(
        `${name}: not a provider to listen to (choose from ${LISTENABLE_PROVIDERS.join(', ')})`,
      );
      continue;
    }
    if (name === 'paystack') {
      const key = env.PAYSTACK_SECRET_KEY;
      if (!key) problems.push('paystack: set PAYSTACK_SECRET_KEY');
      else if (!key.startsWith('sk_test_'))
        problems.push('paystack: only test keys (sk_test_...) can be used');
      else
        sources.push(
          new PaystackSource(
            key,
            trimSlash(env.PAYSTACK_BASE_URL ?? 'https://api.paystack.co'),
            fetchFn,
          ),
        );
    }
    if (name === 'stripe') {
      const key = env.STRIPE_SECRET_KEY;
      const secret = env.STRIPE_WEBHOOK_SECRET;
      if (!key || !secret)
        problems.push(
          'stripe: set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (any whsec_ value works locally)',
        );
      else if (!/^(sk|rk)_test_/.test(key))
        problems.push('stripe: only test keys (sk_test_...) can be used');
      else
        sources.push(
          new StripeSource(
            key,
            secret,
            trimSlash(env.STRIPE_BASE_URL ?? 'https://api.stripe.com'),
            fetchFn,
          ),
        );
    }
    if (name === 'flutterwave') {
      const key = env.FLUTTERWAVE_SECRET_KEY;
      const hash = env.FLUTTERWAVE_WEBHOOK_SECRET_HASH;
      if (!key || !hash)
        problems.push(
          'flutterwave: set FLUTTERWAVE_SECRET_KEY and FLUTTERWAVE_WEBHOOK_SECRET_HASH',
        );
      else if (!key.startsWith('FLWSECK_TEST-'))
        problems.push(
          'flutterwave: only test keys (FLWSECK_TEST-...) can be used',
        );
      else
        sources.push(
          new FlutterwaveSource(
            key,
            hash,
            trimSlash(
              env.FLUTTERWAVE_BASE_URL ?? 'https://api.flutterwave.com/v3',
            ),
            fetchFn,
          ),
        );
    }
  }
  if (names.length === 0) {
    problems.push(
      `no provider to listen to: add paystack, stripe or flutterwave to PAYMENT_PROVIDERS, or pass --provider`,
    );
  }
  return { sources, problems };
}
