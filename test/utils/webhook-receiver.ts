import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';

export interface ReceivedWebhook {
  headers: IncomingHttpHeaders;
  body: string;
}

/** A local HTTP endpoint that records webhook requests and answers as told. */
export class WebhookReceiver {
  readonly received: ReceivedWebhook[] = [];
  private readonly server: Server;
  private statuses: number[] = [];

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.received.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.statusCode = this.statuses.shift() ?? 200;
        res.end('ok');
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
  }

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/hooks`;
  }

  /** The next responses' status codes (then 200). */
  respondWith(...statuses: number[]): void {
    this.statuses = statuses;
  }

  events(): { id: string; type: string; data: Record<string, unknown> }[] {
    return this.received.map(
      (r) =>
        JSON.parse(r.body) as {
          id: string;
          type: string;
          data: Record<string, unknown>;
        },
    );
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
