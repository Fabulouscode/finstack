import { httpConfig } from './http.config';
import { ConfigValidationError } from './validate-config';

describe('httpConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {};
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('defaults to CORS disabled, no proxy and 100 requests per minute', () => {
    expect(httpConfig()).toEqual({
      corsOrigins: [],
      trustProxyHops: 0,
      rateLimit: { ttlMs: 60_000, max: 100 },
    });
  });

  it('parses a comma-separated origin list', () => {
    process.env.CORS_ORIGINS = 'https://app.example.com, http://localhost:5173';

    expect(httpConfig().corsOrigins).toEqual([
      'https://app.example.com',
      'http://localhost:5173',
    ]);
  });

  it('treats an empty CORS_ORIGINS as disabled', () => {
    process.env.CORS_ORIGINS = '';

    expect(httpConfig().corsOrigins).toEqual([]);
  });

  it.each([
    ['CORS_ORIGINS', 'app.example.com'],
    ['CORS_ORIGINS', 'https://app.example.com/path'],
    ['TRUST_PROXY_HOPS', '-1'],
    ['RATE_LIMIT_MAX', '0'],
    ['RATE_LIMIT_TTL_SECONDS', 'soon'],
  ])('rejects invalid %s=%s', (name, value) => {
    process.env[name] = value;

    expect(() => httpConfig()).toThrow(ConfigValidationError);
  });
});
