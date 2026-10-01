import { FLUTTERWAVE_SIGNATURE_HEADER } from '../../payment-providers/flutterwave/flutterwave.provider';
import { Delivery, EventSource, FetchFn, getJson } from './event-source';

interface ListedTransaction {
  id: number;
  tx_ref: string;
  status: string;
  amount: number;
  currency: string;
  created_at?: string;
}

interface ListedTransfer {
  id: number;
  reference: string;
  status: string;
  amount: number;
  currency: string;
  created_at?: string;
}

const DAY_MS = 24 * 3600 * 1000;
const day = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Flutterwave has no events API, so finished transactions and transfers are
 * turned into v3 webhooks (`charge.completed`, `transfer.completed`), sent
 * with the dashboard's secret hash in `verif-hash`, as Flutterwave does.
 */
export class FlutterwaveSource implements EventSource {
  readonly provider = 'flutterwave';

  constructor(
    private readonly secretKey: string,
    private readonly secretHash: string,
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn,
  ) {}

  async poll(since: Date): Promise<Delivery[]> {
    const [transactions, transfers] = await Promise.all([
      this.list<ListedTransaction>('/transactions', since),
      this.list<ListedTransfer>('/transfers', since),
    ]);
    const charges = transactions
      .filter((t) => ['successful', 'failed'].includes(t.status.toLowerCase()))
      .map((t) =>
        this.delivery('charge.completed', t, t.tx_ref, {
          id: t.id,
          tx_ref: t.tx_ref,
          status: t.status,
          amount: t.amount,
          currency: t.currency,
        }),
      );
    const payouts = transfers
      .filter((t) => ['SUCCESSFUL', 'FAILED'].includes(t.status.toUpperCase()))
      .map((t) =>
        this.delivery('transfer.completed', t, t.reference, {
          id: t.id,
          reference: t.reference,
          status: t.status,
          amount: t.amount,
          currency: t.currency,
        }),
      );
    return [...charges, ...payouts]
      .sort((a, b) => a.created - b.created)
      .map(({ delivery }) => delivery);
  }

  private delivery(
    event: string,
    record: { id: number; status: string; created_at?: string },
    reference: string,
    data: object,
  ): { created: number; delivery: Delivery } {
    return {
      created: Date.parse(record.created_at ?? '') || 0,
      delivery: {
        key: `flutterwave:${event}:${record.id}:${record.status}`,
        provider: this.provider,
        type: event,
        reference,
        body: JSON.stringify({ event, data }),
        headers: { [FLUTTERWAVE_SIGNATURE_HEADER]: this.secretHash },
      },
    };
  }

  /** Flutterwave filters by whole days; the exact cut-off is applied here. */
  private async list<T extends { created_at?: string }>(
    path: string,
    since: Date,
  ): Promise<T[]> {
    const query = new URLSearchParams({
      from: day(new Date(since.getTime() - DAY_MS)),
      to: day(new Date(Date.now() + DAY_MS)),
    });
    const body = await getJson<{ data?: T[] }>(
      this.fetchFn,
      `${this.baseUrl}${path}?${query.toString()}`,
      { Authorization: `Bearer ${this.secretKey}` },
    );
    return (body.data ?? []).filter(
      (item) => Date.parse(item.created_at ?? '') >= since.getTime(),
    );
  }
}
