import { appConfig, Environment } from './app.config';
import { ConfigValidationError } from './validate-config';

describe('appConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.NODE_ENV;
    delete process.env.PORT;
    delete process.env.SWAGGER_ENABLED;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('falls back to development defaults', () => {
    expect(appConfig()).toEqual({
      environment: Environment.Development,
      port: 3000,
      isProduction: false,
      swaggerEnabled: true,
    });
  });

  it('reads and converts values from the environment', () => {
    process.env.NODE_ENV = 'production';
    process.env.PORT = '8080';

    expect(appConfig()).toEqual({
      environment: Environment.Production,
      port: 8080,
      isProduction: true,
      swaggerEnabled: false,
    });
  });

  it('lets SWAGGER_ENABLED override the environment default', () => {
    process.env.NODE_ENV = 'production';
    process.env.SWAGGER_ENABLED = 'true';
    expect(appConfig().swaggerEnabled).toBe(true);

    process.env.NODE_ENV = 'development';
    process.env.SWAGGER_ENABLED = 'false';
    expect(appConfig().swaggerEnabled).toBe(false);
  });

  it.each([
    ['NODE_ENV', 'staging'],
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', '30.5'],
    ['SWAGGER_ENABLED', 'yes'],
  ])('rejects invalid %s=%s', (name, value) => {
    process.env[name] = value;

    expect(() => appConfig()).toThrow(ConfigValidationError);
  });
});
