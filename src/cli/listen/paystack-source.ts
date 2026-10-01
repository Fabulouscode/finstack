import { createHmac } from 'node:crypto';
import { PAYSTACK_SIGNATURE_HEADER } from '../../payment-providers/paystack/paystack.provider';
import { Delivery, EventSource, FetchFn, getJson } from './event-source';

interface Listed {
  id: number;
  reference: string;
  status: string;
  amount: number;
  currency: string;
  createdAt?: string;
  created_at?: string;
  transfer_code?: string;
}

const CHARGE_EVENTS: Record<string, string> = {
  success: 'charge.success',
  failed: 'charge.failed',
};
const TRANSFER_EVENTS: Record<string, string> = {
  success: 'transfer.success',
  failed: 'transfer.failed',
  reversed: 'transfer.reversed',
};

/**
 * Paystack has no events API, so finished transactions and transfers are
 * turned into the webhooks Paystack would have sent, signed like Paystack
 * signs them (HMAC-SHA512 of the body with the secret key).
 */
export class PaystackSource implements EventSource {
  readonly provider = 'paystack';

  constructor(
    private readonly secretKey: string,
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn,
  ) {}

  async poll(since: Date): Promise<Delivery[]> {
    const [transactions, transfers] = await Promise.all([
      this.list('/transaction', since),
      this.list('/transfer', since),
    ]);
    return [
      ...transactions.flatMap((t) =>
        this.delivery(CHARGE_EVENTS, 'charge', t, {
          id: t.id,
          reference: t.reference,
          status: t.status,
          amount: t.amount,
          currency: t.currency,
        }),
      ),
      ...transfers.flatMap((t) =>
        this.delivery(TRANSFER_EVENTS, 'transfer', t, {
          id: t.id,
          reference: t.reference,
          transfer_code: t.transfer_code,
          status: t.status,
          amount: t.amount,
          currency: t.currency,
        }),
      ),
    ]
      .sort((a, b) => a.created - b.created)
      .map(({ delivery }) => delivery);
  }

  private delivery(
    events: Record<string, string>,
    kind: string,
    record: Listed,
    data: object,
  ): { created: number; delivery: Delivery }[] {
    const event = events[record.status];
    if (!event) return []; // not finished yet
    const body = JSON.stringify({ event, data });
    return [
      {
        created: Date.parse(record.createdAt ?? record.created_at ?? '') || 0,
        delivery: {
          key: `paystack:${kind}:${record.id}:${record.status}`,
          provider: this.provider,
          type: event,
          reference: record.reference,
          body,
          headers: {
            [PAYSTACK_SIGNATURE_HEADER]: createHmac('sha512', this.secretKey)
              .update(body)
              .digest('hex'),
          },
        },
      },
    ];
  }

  private async list(path: string, since: Date): Promise<Listed[]> {
    const query = new URLSearchParams({
      from: since.toISOString(),
      perPage: '100',
    });
    const body = await getJson<{ data?: Listed[] }>(
      this.fetchFn,
      `${this.baseUrl}${path}?${query.toString()}`,
      { Authorization: `Bearer ${this.secretKey}` },
    );
    return body.data ?? [];
  }
}
