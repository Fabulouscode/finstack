#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { buildSources } from './listen/build-sources';
import { Listener } from './listen/listener';

const HELP = `FinStack developer CLI

Usage:
  finstack listen [options]   Deliver test-mode provider events to a local FinStack

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

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'listen') return listen(rest);
  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    console.log(HELP);
    return 0;
  }
  console.error(`Unknown command "${command}". Commands: listen, help\n`);
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
