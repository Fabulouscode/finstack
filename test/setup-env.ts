import { config as loadEnv } from 'dotenv';

// Integration and e2e tests run against real infrastructure from docker-compose,
// but always against the dedicated test database, never the development one.
loadEnv({ quiet: true });

process.env.NODE_ENV = 'test';
process.env.DATABASE_NAME = process.env.DATABASE_TEST_NAME ?? 'finstack_test';

// Pin behaviour-affecting settings so results never depend on a developer's
// local .env. Individual tests override these where they test the setting.
process.env.DEFAULT_WALLET_CURRENCY = 'USD';
process.env.ALLOWED_WALLET_CURRENCIES = 'USD,NGN';
process.env.FX_SPREAD_BPS = '100';
process.env.FX_QUOTE_TTL_SECONDS = '900';
process.env.FX_RATE_MAX_AGE_SECONDS = '86400';
process.env.PAYMENT_PROVIDERS = 'mock';
process.env.DEFAULT_PAYMENT_PROVIDER = 'mock';
process.env.PAYMENT_SETTLEMENT_DELAY_SECONDS = '0';
process.env.EMAIL_DRIVER = 'log';
process.env.MOCK_PROVIDER_WEBHOOK_SECRET = 'test-mock-webhook-secret';

// Separate Redis DB and key prefix, so tests never touch development queues.
process.env.REDIS_DB = process.env.REDIS_TEST_DB ?? '1';
process.env.QUEUE_PREFIX = 'finstack-test';
process.env.OUTBOX_POLL_INTERVAL_MS = '100';
process.env.WEBHOOK_MAX_ATTEMPTS = '5';
process.env.WEBHOOK_RETRY_BACKOFF_MS = '200';
