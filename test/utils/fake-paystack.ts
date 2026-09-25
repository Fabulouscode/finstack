import { createHmac } from 'node:crypto';
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

interface FakeTransaction {
  id: number;
  reference: string;
  amount: number;
  currency: string;
  status: 'ongoing' | 'success' | 'failed';
}

/**
 * A local stand-in for the Paystack API: same paths, envelopes and webhook
 * signing, so the adapter and the whole payment pipeline run over real HTTP
 * without calling Paystack.
 */
export class FakePaystack {
  readonly requests: {
    method: string;
    path: string;
    authorization?: string;
  }[] = [];
  private readonly transactions = new Map<string, FakeTransaction>();
  private readonly server: Server;
  private nextId = 1000;
  private failures: number[] = [];

  constructor(private readonly secretKey: string) {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** The next responses fail with these HTTP statuses (e.g. an outage). */
  failNext(...statuses: number[]): void {
    this.failures.push(...statuses);
  }

  /** The customer completes (or fails) checkout; returns the signed webhook. */
  complete(
    reference: string,
    outcome: 'success' | 'failed',
  ): { rawBody: Buffer; signature: string } {
    const transaction = this.transactions.get(reference);
    if (!transaction)
      throw new Error(`Unknown fake Paystack reference ${reference}`);
    transaction.status = outcome;

    const rawBody = Buffer.from(
      JSON.stringify({
        event: outcome === 'success' ? 'charge.success' : 'charge.failed',
        data: { ...transaction },
      }),
    );
    return {
      rawBody,
      signature: createHmac('sha512', this.secretKey)
        .update(rawBody)
        .digest('hex'),
    };
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJson(req);
    const path = req.url ?? '';
    this.requests.push({
      method: req.method ?? '',
      path,
      authorization: req.headers.authorization,
    });

    const failure = this.failures.shift();
    if (failure) {
      return send(res, failure, {
        status: false,
        message: 'Simulated failure',
      });
    }
    if (req.headers.authorization !== `Bearer ${this.secretKey}`) {
      return send(res, 401, { status: false, message: 'Invalid key' });
    }

    if (req.method === 'POST' && path === '/transaction/initialize') {
      const reference = String(body.reference);
      if (
        !['NGN', 'USD', 'GHS', 'ZAR', 'KES'].includes(String(body.currency))
      ) {
        return send(res, 400, {
          status: false,
          message: 'Currency not supported by merchant',
        });
      }
      const existing = this.transactions.get(reference);
      const transaction = existing ?? {
        id: this.nextId++,
        reference,
        amount: Number(body.amount),
        currency: String(body.currency),
        status: 'ongoing' as const,
      };
      this.transactions.set(reference, transaction);
      return send(res, 200, {
        status: true,
        message: 'Authorization URL created',
        data: {
          authorization_url: `https://checkout.paystack.test/${transaction.id}`,
          access_code: `ac_${transaction.id}`,
          reference,
        },
      });
    }

    const verify = /^\/transaction\/verify\/(.+)$/.exec(path);
    if (req.method === 'GET' && verify?.[1]) {
      const transaction = this.transactions.get(decodeURIComponent(verify[1]));
      if (!transaction) {
        return send(res, 404, {
          status: false,
          message: 'Transaction reference not found',
        });
      }
      return send(res, 200, {
        status: true,
        message: 'Verification successful',
        data: transaction,
      });
    }

    return send(res, 404, { status: false, message: 'Not found' });
  }
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
