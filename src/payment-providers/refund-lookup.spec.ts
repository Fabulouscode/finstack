import { PaymentProviderError } from './payment-provider';
import { pickOurRefund } from './refund-lookup';

interface R {
  id: number;
  note?: string | null;
}
const pick = (refunds: R[]): R | null =>
  pickOurRefund(refunds, 'rfd_ours', (r) => r.note, 'Provider');

describe('pickOurRefund', () => {
  it('finds the refund labelled with our reference', () => {
    expect(
      pick([
        { id: 1, note: 'rfd_other' },
        { id: 2, note: ' rfd_ours ' },
      ]),
    ).toEqual({ id: 2, note: ' rfd_ours ' });
  });

  it('confirms we have none when there are no refunds', () => {
    expect(pick([])).toBeNull();
  });

  it('confirms we have none when every refund is labelled as someone else', () => {
    expect(
      pick([
        { id: 1, note: 'rfd_other' },
        { id: 2, note: 'Refunded from the dashboard' },
      ]),
    ).toBeNull();
  });

  it.each([null, undefined, '', '   '])(
    'refuses to guess when a refund has no label (%p)',
    (note) => {
      let error: unknown;
      try {
        pick([
          { id: 1, note: 'rfd_other' },
          { id: 2, note },
        ]);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect(error).toMatchObject({ retryable: true });
    },
  );
});
