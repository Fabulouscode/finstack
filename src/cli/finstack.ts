#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildSources } from './listen/build-sources';
import { Listener } from './listen/listener';
import { FinStackClient } from './mcp/finstack-client';
import { createFinStackMcpServer } from './mcp/server';

const HELP = `FinStack developer CLI

Usage:
  finstack listen [options]   Deliver test-mode provider events to a local FinStack
  finstack mcp [options]      Serve FinStack to an AI agent over MCP (stdio)

Options for listen:
  --provider <name>   paystack, stripe or flutterwave (repeatable). Default: the
                      enabled ones in PAYMENT_PROVIDERS
  --forward-to <url>  FinStack's URL. Default: http://localhost:$PORT (3000)
  --interval <secs>   How often to poll each provider. Default: 3
  --lookback <hours>  Watch records created up to this long ago. Default: 24
  --replay            Also deliver events that already exist when starting
  --env-file <path>   Settings file. Default: .env

How it works: the CLI asks each provider's API (with your test key) for new
payments and payouts, and posts them to FinStack as signed webhooks. No tunnel,
public URL or dashboard setup is needed. Only test keys are accepted.

Options for mcp:
  --url <url>         FinStack's URL. Default: FINSTACK_URL, or http://localhost:$PORT
  --env-file <path>   Settings file. Default: .env
  Needs FINSTACK_API_KEY (scopes: proposals:create and the read scopes) and
  FINSTACK_ORGANIZATION_ID. The agent can read and propose payouts; a person
  approves every proposal in FinStack.
`;

async function listen(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      provider: { type: 'string', multiple: true, default: [] },
      'forward-to': { type: 'string' },
      interval: { type: 'string', default: '3' },
      lookback: { type: 'string', default: '24' },
      replay: { type: 'boolean', default: false },
      'env-file': { type: 'string', default: '.env' },
    },
  });

  const envFile = values['env-file'];
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  } else if (argv.includes('--env-file')) {
    console.error(`${envFile} not found`);
    return 1;
  }

  const intervalMs = Number(values.interval) * 1000;
  const lookbackMs = Number(values.lookback) * 3600 * 1000;
  if (!(intervalMs >= 1000) || !(lookbackMs > 0)) {
    console.error('--interval must be at least 1 and --lookback above 0');
    return 1;
  }

  const { sources, problems } = buildSources(
    process.env,
    values.provider,
    fetch,
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    return 1;
  }

  const forwardTo = (
    values['forward-to'] ?? `http://localhost:${process.env.PORT ?? '3000'}`
  ).replace(/\/+$/, '');
  const listener = new Listener({
    sources,
    forwardTo,
    since: new Date(Date.now() - lookbackMs),
    replay: values.replay,
    fetchFn: fetch,
    log: (line) =>
      console.log(`${new Date().toISOString().slice(11, 19)} ${line}`),
  });

  console.log(
    `Listening for ${sources.map((s) => s.provider).join(', ')} test events → ${forwardTo}/v1/webhooks/:provider`,
  );
  console.log(
    values.replay
      ? 'Replaying recent events, then watching for new ones. Ctrl+C to stop.'
      : 'Watching for new events. Ctrl+C to stop.',
  );

  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  while (!stop.signal.aborted) {
    await listener.tick();
    await sleep(intervalMs, undefined, { signal: stop.signal }).catch(
      () => undefined,
    );
  }
  console.log('Stopped.');
  return 0;
}

async function mcp(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      'env-file': { type: 'string', default: '.env' },
    },
  });
  if (existsSync(values['env-file'])) process.loadEnvFile(values['env-file']);

  // stdout carries the MCP protocol: everything else goes to stderr.
  const apiKey = process.env.FINSTACK_API_KEY;
  const organizationId = process.env.FINSTACK_ORGANIZATION_ID;
  if (!apiKey || !organizationId) {
    console.error(
      'Set FINSTACK_API_KEY and FINSTACK_ORGANIZATION_ID (an API key with proposals:create and read scopes).',
    );
    return 1;
  }
  const baseUrl =
    values.url ??
    process.env.FINSTACK_URL ??
    `http://localhost:${process.env.PORT ?? '3000'}`;

  const server = createFinStackMcpServer(
    new FinStackClient({ baseUrl, apiKey, organizationId }),
  );
  await server.connect(new StdioServerTransport());
  console.error(
    `FinStack MCP server ready (${baseUrl}, organization ${organizationId})`,
  );
  await new Promise<void>((resolve) => process.stdin.once('close', resolve));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'listen') return listen(rest);
  if (command === 'mcp') return mcp(rest);
  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    console.log(HELP);
    return 0;
  }
  console.error(`Unknown command "${command}". Commands: listen, mcp, help\n`);
  console.log(HELP);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
