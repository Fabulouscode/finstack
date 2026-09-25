import { createHmac, randomBytes } from 'node:crypto';
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

interface FakeSession {
  id: string;
  object: 'checkout.session';
  url: string;
  client_reference_id: string;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid';
  amount_total: number;
  currency: string;
  payment_intent: string | null;
}

/**
 * A local stand-in for the Stripe API: form-encoded requests, Idempotency-Key
 * replay, Checkout Sessions and `Stripe-Signature` (t=..., v1=...) webhooks.
 */
export class FakeStripe {
  readonly requests: {
    method: string;
    path: string;
    idempotencyKey?: string;
  }[] = [];
  private readonly sessions = new Map<string, FakeSession>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly server: Server;

  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
  ) {
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

  /** Customer pays (or the session expires); returns the signed event. */
  complete(
    sessionId: string,
    outcome: 'paid' | 'expired',
    options: { signedSecondsAgo?: number } = {},
  ): { rawBody: Buffer; signature: string } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown fake Stripe session ${sessionId}`);
    if (outcome === 'paid') {
      Object.assign(session, {
        status: 'complete',
        payment_status: 'paid',
        payment_intent: `pi_${randomBytes(6).toString('hex')}`,
      });
    } else {
      session.status = 'expired';
    }

    const rawBody = Buffer.from(
      JSON.stringify({
        id: `evt_${randomBytes(8).toString('hex')}`,
        object: 'event',
        type:
          outcome === 'paid'
            ? 'checkout.session.completed'
            : 'checkout.session.expired',
        data: { object: session },
      }),
    );
    const t = Math.floor(Date.now() / 1000) - (options.signedSecondsAgo ?? 0);
    const v1 = createHmac('sha256', this.webhookSecret)
      .update(`${t}.`)
      .update(rawBody)
      .digest('hex');
    return { rawBody, signature: `t=${t},v1=${v1}` };
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const form = new URLSearchParams(await readBody(req));
    const path = req.url ?? '';
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    this.requests.push({ method: req.method ?? '', path, idempotencyKey });

    if (req.headers.authorization !== `Bearer ${this.secretKey}`) {
      return send(res, 401, {
        error: {
          type: 'invalid_request_error',
          message: 'Invalid API Key provided',
        },
      });
    }

    if (req.method === 'POST' && path === '/v1/checkout/sessions') {
      const replayed = idempotencyKey
        ? this.byIdempotencyKey.get(idempotencyKey)
        : undefined;
      if (replayed) return send(res, 200, this.sessions.get(replayed) ?? {});

      const id = `cs_test_${randomBytes(8).toString('hex')}`;
      const session: FakeSession = {
        id,
        object: 'checkout.session',
        url: `https://checkout.stripe.test/c/pay/${id}`,
        client_reference_id: form.get('client_reference_id') ?? '',
        status: 'open',
        payment_status: 'unpaid',
        amount_total: Number(
          form.get('line_items[0][price_data][unit_amount]'),
        ),
        currency: form.get('line_items[0][price_data][currency]') ?? '',
        payment_intent: null,
      };
      this.sessions.set(id, session);
      if (idempotencyKey) this.byIdempotencyKey.set(idempotencyKey, id);
      return send(res, 200, session);
    }

    const get = /^\/v1\/checkout\/sessions\/(.+)$/.exec(path);
    if (req.method === 'GET' && get?.[1]) {
      const session = this.sessions.get(decodeURIComponent(get[1]));
      return session
        ? send(res, 200, session)
        : send(res, 404, { error: { message: 'No such checkout.session' } });
    }

    return send(res, 404, { error: { message: 'Unrecognized request URL' } });
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
