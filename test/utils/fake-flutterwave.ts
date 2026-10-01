import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

interface FakeTransaction {
  id: number;
  tx_ref: string;
  flw_ref: string;
  /** Major units, as Flutterwave reports them. */
  amount: number;
  currency: string;
  status: 'pending' | 'successful' | 'failed';
  created_at: string;
}

interface FakeTransfer {
  id: number;
  reference: string;
  beneficiary: number;
  amount: number;
  currency: string;
  status: 'NEW' | 'SUCCESSFUL' | 'FAILED';
  complete_message: string;
  created_at: string;
}

const CURRENCIES = ['NGN', 'USD', 'GHS', 'KES', 'ZAR', 'EUR', 'GBP'];

/**
 * A local stand-in for the Flutterwave v3 API: same paths, envelopes,
 * major-unit amounts and `verif-hash` webhooks, so the adapter and the
 * whole payment pipeline run over real HTTP without calling Flutterwave.
 */
export class FakeFlutterwave {
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  readonly transactions = new Map<string, FakeTransaction>();
  readonly transfers: FakeTransfer[] = [];
  private readonly refunds = new Map<number, { id: number; status: string }>();
  readonly beneficiaries: {
    id: number;
    account_number: string;
    bank_code: string;
    full_name: string;
    bank_name: string;
  }[] = [];
  private readonly server: Server;
  private nextId = 5000;
  private failures: number[] = [];

  constructor(
    private readonly secretKey: string,
    private readonly secretHash: string,
  ) {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v3`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** The next responses fail with these HTTP statuses (e.g. an outage). */
  failNext(...statuses: number[]): void {
    this.failures.push(...statuses);
  }

  /** The customer completes (or fails) checkout; returns the webhook. */
  complete(
    txRef: string,
    outcome: 'successful' | 'failed',
    overrides: { amount?: number } = {},
  ): { rawBody: Buffer; hash: string } {
    const transaction = this.transactions.get(txRef);
    if (!transaction) throw new Error(`Unknown fake tx_ref ${txRef}`);
    transaction.status = outcome;
    if (overrides.amount !== undefined) transaction.amount = overrides.amount;
    return this.webhook({ event: 'charge.completed', data: transaction });
  }

  /** The bank settles (or rejects) a transfer; returns the webhook. */
  settleTransfer(
    reference: string,
    outcome: 'SUCCESSFUL' | 'FAILED',
  ): { rawBody: Buffer; hash: string } {
    const transfer = this.transfers.find((t) => t.reference === reference);
    if (!transfer) throw new Error(`Unknown fake transfer ${reference}`);
    transfer.status = outcome;
    transfer.complete_message =
      outcome === 'SUCCESSFUL' ? 'Transfer was successful' : 'Account blocked';
    return this.webhook({
      event: 'transfer.completed',
      'event.type': 'Transfer',
      data: transfer,
    });
  }

  private webhook(body: object): { rawBody: Buffer; hash: string } {
    return {
      rawBody: Buffer.from(JSON.stringify(body)),
      hash: this.secretHash,
    };
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJson(req);
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname.replace(/^\/v3/, '');
    const method = req.method ?? '';
    this.requests.push({ method, path: `${path}${url.search}`, body });

    const failure = this.failures.shift();
    if (failure) {
      return send(res, failure, {
        status: 'error',
        message: 'Simulated failure',
      });
    }
    if (req.headers.authorization !== `Bearer ${this.secretKey}`) {
      return send(res, 401, {
        status: 'error',
        message: 'Invalid authorization key',
      });
    }

    if (method === 'POST' && path === '/payments') {
      if (!CURRENCIES.includes(String(body.currency))) {
        return error(res, 'Invalid currency');
      }
      const txRef = String(body.tx_ref);
      const transaction = this.transactions.get(txRef) ?? {
        id: this.nextId++,
        tx_ref: txRef,
        flw_ref: `FLW-MOCK-${this.nextId}`,
        amount: Number(body.amount),
        currency: String(body.currency),
        status: 'pending' as const,
        created_at: new Date().toISOString(),
      };
      this.transactions.set(txRef, transaction);
      return ok(res, {
        link: `https://checkout.flutterwave.test/v3/hosted/pay/${transaction.id}`,
      });
    }

    if (method === 'GET' && path === '/transactions/verify_by_reference') {
      const transaction = this.transactions.get(
        url.searchParams.get('tx_ref') ?? '',
      );
      return transaction
        ? ok(res, transaction)
        : error(res, 'No transaction was found for this id');
    }

    const refund = /^\/transactions\/(\d+)\/refund$/.exec(path);
    if (method === 'POST' && refund) {
      const id = this.nextId++;
      this.refunds.set(id, { id, status: 'completed' });
      return ok(res, {
        id,
        tx_id: Number(refund[1]),
        amount_refunded: Number(body.amount),
        status: 'completed',
      });
    }

    const getRefund = /^\/refunds\/(\d+)$/.exec(path);
    if (method === 'GET' && getRefund) {
      const found = this.refunds.get(Number(getRefund[1]));
      return found ? ok(res, found) : error(res, 'Refund not found');
    }

    if (method === 'POST' && path === '/accounts/resolve') {
      return ok(res, {
        account_number: String(body.account_number),
        account_name: 'ADA LOVELACE',
      });
    }

    if (method === 'POST' && path === '/beneficiaries') {
      const accountNumber = String(body.account_number);
      const bankCode = String(body.account_bank);
      // Like the real API: one beneficiary per bank account.
      if (
        this.beneficiaries.some(
          (b) => b.account_number === accountNumber && b.bank_code === bankCode,
        )
      ) {
        return error(res, 'Beneficiary already added to your account');
      }
      const beneficiary = {
        id: this.nextId++,
        account_number: accountNumber,
        bank_code: bankCode,
        full_name: String(body.beneficiary_name),
        bank_name: 'ACCESS BANK NIGERIA',
      };
      this.beneficiaries.push(beneficiary);
      return ok(res, beneficiary);
    }

    if (method === 'GET' && path === '/beneficiaries') {
      return ok(res, this.beneficiaries, {
        page_info: {
          total: this.beneficiaries.length,
          current_page: 1,
          total_pages: 1,
        },
      });
    }

    if (method === 'POST' && path === '/transfers') {
      const reference = String(body.reference);
      if (this.transfers.some((t) => t.reference === reference)) {
        return error(res, 'Transfer with this reference already exists');
      }
      const transfer: FakeTransfer = {
        id: this.nextId++,
        reference,
        beneficiary: Number(body.beneficiary),
        amount: Number(body.amount),
        currency: String(body.currency),
        status: 'NEW',
        complete_message: '',
        created_at: new Date().toISOString(),
      };
      this.transfers.push(transfer);
      return ok(res, transfer);
    }

    if (method === 'GET' && path === '/transfers') {
      const reference = url.searchParams.get('reference');
      return ok(
        res,
        this.transfers.filter((t) => !reference || t.reference === reference),
        {
          page_info: {
            total: this.transfers.length,
            current_page: 1,
            total_pages: 1,
          },
        },
      );
    }

    if (method === 'GET' && path === '/transactions') {
      const all = [...this.transactions.values()];
      return ok(res, all, {
        page_info: { total: all.length, current_page: 1, total_pages: 1 },
      });
    }

    return send(res, 404, { status: 'error', message: 'Not found' });
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

function ok(res: ServerResponse, data: unknown, meta?: object): void {
  send(res, 200, {
    status: 'success',
    message: 'ok',
    data,
    ...(meta ? { meta } : {}),
  });
}

function error(res: ServerResponse, message: string): void {
  send(res, 400, { status: 'error', message, data: null });
}

function send(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
