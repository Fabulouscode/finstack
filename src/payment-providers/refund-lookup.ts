import { PaymentProviderError } from './payment-provider';

/**
 * Finds OUR refund among a transaction's refunds, for providers that echo
 * our reference back in a free-text note (Paystack's `merchant_note`,
 * Flutterwave's `comment`). Never guesses:
 *
 * - a refund whose note is our reference: ours;
 * - no refunds, or only refunds labelled with other notes: we have none;
 * - any refund without a note: it might be ours with the note dropped, so
 *   we can't tell, and throw (retryable) rather than allow a resend.
 */
export function pickOurRefund<T>(
  refunds: readonly T[],
  reference: string,
  noteOf: (refund: T) => string | null | undefined,
  provider: string,
): T | null {
  const ours = refunds.find((refund) => noteOf(refund)?.trim() === reference);
  if (ours) return ours;
  if (refunds.some((refund) => !noteOf(refund)?.trim())) {
    throw new PaymentProviderError(
      `${provider} has unlabelled refunds on this payment; cannot tell whether refund ${reference} was made`,
      true,
    );
  }
  return null;
}
