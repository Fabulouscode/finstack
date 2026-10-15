import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FinStackClient } from './finstack-client';
import { createFinStackMcpServer } from './server';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEST = '22222222-2222-4222-8222-222222222222';

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

async function connect(
  reply: (sent: Sent) => { status: number; body: unknown },
): Promise<{ client: Client; sent: Sent[] }> {
  const sent: Sent[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    const request: Sent = {
      method: String(init.method),
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    sent.push(request);
    const { status, body } = reply(request);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;

  const server = createFinStackMcpServer(
    new FinStackClient({
      baseUrl: 'http://finstack.test/',
      apiKey: 'fsk_test',
      organizationId: ORG,
      fetchFn,
    }),
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, sent };
}

const text = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as { type: string; text: string }[])[0]?.text ?? '';

describe('FinStack MCP server', () => {
  it('offers read tools and exactly one write tool, which only proposes', async () => {
    const { client } = await connect(() => ({ status: 200, body: {} }));
    const { tools } = await client.listTools();

    const writes = tools.filter(
      (tool) => tool.annotations?.readOnlyHint !== true,
    );
    expect(writes.map((tool) => tool.name)).toEqual([
      'finstack_propose_payout',
    ]);
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/approve|pay_now|send|transfer/),
      ]),
    );
    expect(tools.length).toBeGreaterThanOrEqual(9);
  });

  it('tells the agent it cannot move money', async () => {
    const { client } = await connect(() => ({ status: 200, body: {} }));
    expect(client.getInstructions()).toMatch(/cannot move money/);
  });

  it('reads with the API key, under the organization', async () => {
    const wallets = [
      { id: 'w1', currency: 'USD', balances: { available: 1000 } },
    ];
    const { client, sent } = await connect(() => ({
      status: 200,
      body: wallets,
    }));

    const result = await client.callTool({
      name: 'finstack_list_wallets',
      arguments: {},
    });

    expect(JSON.parse(text(result))).toEqual(wallets);
    expect(sent[0]).toMatchObject({
      method: 'GET',
      url: `http://finstack.test/v1/organizations/${ORG}/wallets`,
    });
    expect(sent[0]?.headers['X-API-Key']).toBe('fsk_test');
  });

  it('passes filters through as query parameters', async () => {
    const { client, sent } = await connect(() => ({ status: 200, body: [] }));
    await client.callTool({
      name: 'finstack_list_proposals',
      arguments: { status: 'pending' },
    });
    await client.callTool({
      name: 'finstack_quote_payout_fee',
      arguments: { currency: 'USD', amount: 2500 },
    });
    expect(sent.map((s) => s.url)).toEqual([
      `http://finstack.test/v1/organizations/${ORG}/proposals?status=pending`,
      `http://finstack.test/v1/organizations/${ORG}/fees/quote?operation=payout&currency=USD&amount=2500`,
    ]);
  });

  it('turns a payout idea into a proposal, not a payout', async () => {
    const { client, sent } = await connect(() => ({
      status: 201,
      body: { id: 'p1', status: 'pending' },
    }));

    const result = await client.callTool({
      name: 'finstack_propose_payout',
      arguments: {
        destinationId: DEST,
        amount: 2500,
        summary: 'Pay Ada $25 for October design work',
        reasoning: 'Invoice INV-104 is approved and unpaid.',
        evidence: { invoice: 'INV-104' },
      },
    });

    expect(result.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: `http://finstack.test/v1/organizations/${ORG}/proposals`,
      body: {
        kind: 'payout',
        destinationId: DEST,
        amount: 2500,
        evidence: { invoice: 'INV-104' },
      },
    });
  });

  it('rejects malformed tool input before calling FinStack', async () => {
    const { client, sent } = await connect(() => ({ status: 201, body: {} }));
    const result = await client.callTool({
      name: 'finstack_propose_payout',
      arguments: {
        destinationId: 'not-a-uuid',
        amount: -5,
        summary: 'x',
        reasoning: 'y',
      },
    });
    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("hands FinStack's refusal back to the agent as a readable error", async () => {
    const { client } = await connect(() => ({
      status: 404,
      body: {
        code: 'PAYOUT_DESTINATION_NOT_FOUND',
        detail: 'Payout destination not found',
      },
    }));
    const result = await client.callTool({
      name: 'finstack_propose_payout',
      arguments: {
        destinationId: DEST,
        amount: 100,
        summary: 'Pay someone',
        reasoning: 'Because.',
      },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      'FinStack answered 404 PAYOUT_DESTINATION_NOT_FOUND: Payout destination not found',
    );
  });
});
