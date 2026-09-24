import { appConfig, Environment } from './app.config';
import { ConfigValidationError } from './validate-config';

describe('appConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.NODE_ENV;
    delete process.env.PORT;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('falls back to development defaults', () => {
    expect(appConfig()).toEqual({
      environment: Environment.Development,
      port: 3000,
      isProduction: false,
    });
  });

  it('reads and converts values from the environment', () => {
    process.env.NODE_ENV = 'production';
    process.env.PORT = '8080';

    expect(appConfig()).toEqual({
      environment: Environment.Production,
      port: 8080,
      isProduction: true,
    });
  });

  it.each([
    ['NODE_ENV', 'staging'],
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', '30.5'],
  ])('rejects invalid %s=%s', (name, value) => {
    process.env[name] = value;

    expect(() => appConfig()).toThrow(ConfigValidationError);
  });
});
