import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  WebhookDelivery,
  WebhookDeliveryStatus,
} from './webhook-delivery.entity';
import { WebhookSender } from './webhook-sender';

describe('WebhookSender', () => {
  let server: Server;
  let port: number;
  let received: { headers: IncomingHttpHeaders; body: string }[];
  let status = 200;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.statusCode = status;
        res.end('nope');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  beforeEach(() => {
    received = [];
    status = 200;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const sender = new WebhookSender({
    maxAttempts: 3,
    backoffMs: 10,
    timeoutMs: 2_000,
    disableAfterFailures: 5,
    allowPrivateUrls: true,
    requireHttps: false,
  });
  const delivery = {
    id: 'd-1',
    eventId: 'e-1',
    eventType: 'payment.successful',
    payload: { id: 'e-1', type: 'payment.successful' },
    status: WebhookDeliveryStatus.Pending,
  } as WebhookDelivery;

  it('connects to the pinned address, never resolving the name again', async () => {
    // `.test` names never resolve in DNS: this only works if the pinned
    // address is used for the connection.
    const url = new URL(`http://hooks.example.test:${port}/finstack?x=1`);

    const result = await sender.send(
      { url, address: '127.0.0.1', family: 4 },
      delivery,
      ['whsec_test'],
    );

    expect(result).toEqual({ ok: true, status: 200 });
    expect(received[0]?.headers.host).toBe(`hooks.example.test:${port}`);
    expect(received[0]?.headers['finstack-event-id']).toBe('e-1');
    expect(JSON.parse(received[0]?.body ?? '{}')).toEqual(delivery.payload);
  });

  it('reports non-2xx responses and does not follow redirects', async () => {
    const target = {
      url: new URL(`http://127.0.0.1:${port}/`),
      address: '127.0.0.1',
      family: 4 as const,
    };
    status = 503;
    await expect(sender.send(target, delivery, ['s'])).resolves.toEqual({
      ok: false,
      status: 503,
      error: 'HTTP 503: nope',
    });
    status = 302;
    await expect(sender.send(target, delivery, ['s'])).resolves.toMatchObject({
      ok: false,
      error: 'Redirects are not followed (HTTP 302)',
    });
    expect(received).toHaveLength(2);
  });

  it('reports connection failures', async () => {
    const result = await sender.send(
      {
        url: new URL('http://hooks.example.test:1/'),
        address: '127.0.0.1',
        family: 4,
      },
      delivery,
      ['s'],
    );
    expect(result).toMatchObject({ ok: false, status: null });
  });
});
