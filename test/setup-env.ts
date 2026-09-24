import { config as loadEnv } from 'dotenv';

// Integration and e2e tests run against real infrastructure from docker-compose,
// but always against the dedicated test database, never the development one.
loadEnv({ quiet: true });

process.env.NODE_ENV = 'test';
process.env.DATABASE_NAME = process.env.DATABASE_TEST_NAME ?? 'finstack_test';
