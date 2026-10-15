import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FinStackApiError, FinStackClient } from './finstack-client';

export const INSTRUCTIONS = `You are working with FinStack, the money system of one organization.

Rules:
- You can read wallets, transactions, payments, payouts and payout destinations, and you can PROPOSE a payout. You cannot move money: a person must approve every proposal in FinStack, and only then is it paid.
- Amounts are integers in minor units of the currency: 2500 USD is $25.00; 500 JPY is ¥500.
- Before proposing, check the wallet balance, the destination, and finstack_list_proposals for a pending or executed proposal that already covers the same payment. Never propose the same payment twice.
- Every proposal needs a one-line summary a busy person can approve from, your reasoning, and the evidence you checked (record ids, figures, dates).
- If something looks wrong (a duplicate payment, a payout stuck in processing, a balance that doesn't add up), explain it with the evidence instead of proposing a fix you aren't sure of.`;

const json = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

/** FinStack's refusals go back to the model as tool errors it can read and act on. */
async function call(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await run());
  } catch (error) {
    const message =
      error instanceof FinStackApiError
        ? `FinStack answered ${error.status}${error.code ? ` ${error.code}` : ''}: ${error.message}`
        : `Could not reach FinStack: ${error instanceof Error ? error.message : String(error)}`;
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}

const id = (what: string): z.ZodString =>
  z.string().uuid().describe(`The ${what}'s id`);

/**
 * The MCP server: read-only tools over FinStack's organization API, and one
 * write tool, finstack_propose_payout, which creates a proposal for a person
 * to approve. There is deliberately no tool that approves or pays.
 */
export function createFinStackMcpServer(client: FinStackClient): McpServer {
  const server = new McpServer(
    { name: 'finstack', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    'finstack_list_wallets',
    {
      title: 'List wallets',
      description:
        "The organization's wallets, with available, pending and reserved balances in minor units.",
      annotations: readOnly,
    },
    () => call(() => client.get(client.org('/wallets'))),
  );

  server.registerTool(
    'finstack_list_wallet_entries',
    {
      title: 'Wallet history',
      description:
        "A wallet's ledger entries, newest first: every credit and debit with its transaction.",
      inputSchema: {
        walletId: id('wallet'),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z
          .string()
          .optional()
          .describe('nextCursor from the previous page'),
      },
      annotations: readOnly,
    },
    ({ walletId, limit, cursor }) =>
      call(() =>
        client.get(client.org(`/wallets/${walletId}/entries`), {
          limit,
          cursor,
        }),
      ),
  );

  server.registerTool(
    'finstack_list_transactions',
    {
      title: 'List transactions',
      description:
        'Payments, payouts, transfers and refunds, newest first, with type, status, amount and reference.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z
          .string()
          .optional()
          .describe('nextCursor from the previous page'),
      },
      annotations: readOnly,
    },
    ({ limit, cursor }) =>
      call(() => client.get(client.org('/transactions'), { limit, cursor })),
  );

  server.registerTool(
    'finstack_get_transaction',
    {
      title: 'Get a transaction',
      description: 'One transaction by id, with its status history.',
      inputSchema: { transactionId: id('transaction') },
      annotations: readOnly,
    },
    ({ transactionId }) =>
      call(() => client.get(client.org(`/transactions/${transactionId}`))),
  );

  server.registerTool(
    'finstack_get_payment',
    {
      title: 'Get a payment',
      description:
        'A payment (money in) by id: provider, provider reference, status, amount and any currency conversion.',
      inputSchema: { paymentId: id('payment') },
      annotations: readOnly,
    },
    ({ paymentId }) =>
      call(() => client.get(client.org(`/payments/${paymentId}`))),
  );

  server.registerTool(
    'finstack_get_payout',
    {
      title: 'Get a payout',
      description:
        'A payout (money out) by id: destination, provider reference, status and failure reason.',
      inputSchema: { payoutId: id('payout') },
      annotations: readOnly,
    },
    ({ payoutId }) =>
      call(() => client.get(client.org(`/payouts/${payoutId}`))),
  );

  server.registerTool(
    'finstack_list_payout_destinations',
    {
      title: 'List payout destinations',
      description:
        'Saved accounts the organization can pay: bank accounts (last 4 digits) and PayPal accounts (masked email). Payouts can only go to these.',
      annotations: readOnly,
    },
    () => call(() => client.get(client.org('/payout-destinations'))),
  );

  server.registerTool(
    'finstack_quote_payout_fee',
    {
      title: 'Quote a payout fee',
      description:
        'What FinStack would charge for a payout of this amount, and the total taken from the wallet.',
      inputSchema: {
        currency: z.string().length(3).describe('ISO currency, e.g. USD'),
        amount: z.number().int().positive().describe('Minor units'),
      },
      annotations: readOnly,
    },
    ({ currency, amount }) =>
      call(() =>
        client.get(client.org('/fees/quote'), {
          operation: 'payout',
          currency,
          amount,
        }),
      ),
  );

  server.registerTool(
    'finstack_list_proposals',
    {
      title: 'List proposals',
      description:
        'Proposals made so far, newest first, and their status (pending, executed, failed, rejected, expired). Check this before proposing, to avoid duplicates.',
      inputSchema: {
        status: z
          .enum(['pending', 'executed', 'failed', 'rejected', 'expired'])
          .optional(),
      },
      annotations: readOnly,
    },
    ({ status }) =>
      call(() => client.get(client.org('/proposals'), { status })),
  );

  server.registerTool(
    'finstack_propose_payout',
    {
      title: 'Propose a payout',
      description:
        'Proposes paying a saved destination. This does NOT pay: it creates a proposal that a person reviews and approves in FinStack. Include a clear summary, your reasoning and the evidence you checked.',
      inputSchema: {
        destinationId: id('payout destination'),
        amount: z
          .number()
          .int()
          .positive()
          .describe('Minor units, e.g. 2500 for $25.00'),
        summary: z
          .string()
          .min(5)
          .max(300)
          .describe(
            'One line the approver reads first, e.g. "Pay Ada $25 for October design work"',
          ),
        reasoning: z
          .string()
          .min(5)
          .max(4000)
          .describe('Why this payment is right'),
        evidence: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('What you checked: record ids, figures, dates'),
        narration: z
          .string()
          .max(100)
          .optional()
          .describe("Shown on the recipient's side"),
        walletId: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Wallet to pay from; defaults to the one in the destination's currency",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) =>
      call(() =>
        client.post(client.org('/proposals'), { kind: 'payout', ...input }),
      ),
  );

  return server;
}
