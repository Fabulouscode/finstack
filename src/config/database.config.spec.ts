import { databaseConfig } from './database.config';
import { ConfigValidationError } from './validate-config';

describe('databaseConfig', () => {
  const originalEnv = process.env;
  const required = {
    DATABASE_USER: 'finstack',
    DATABASE_PASSWORD: 'secret',
    DATABASE_NAME: 'finstack',
  };

  beforeEach(() => {
    process.env = { ...required };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('applies defaults for optional settings', () => {
    expect(databaseConfig()).toEqual({
      host: 'localhost',
      port: 5432,
      user: 'finstack',
      password: 'secret',
      name: 'finstack',
      ssl: false,
      logging: false,
      poolMax: 10,
    });
  });

  it('parses booleans and numbers from strings', () => {
    process.env = {
      ...required,
      DATABASE_PORT: '6543',
      DATABASE_SSL: 'true',
      DATABASE_LOGGING: 'true',
      DATABASE_POOL_MAX: '25',
    };

    expect(databaseConfig()).toMatchObject({
      port: 6543,
      ssl: true,
      logging: true,
      poolMax: 25,
    });
  });

  it.each(['DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME'])(
    'requires %s',
    (name) => {
      delete process.env[name];

      expect(() => databaseConfig()).toThrow(ConfigValidationError);
    },
  );

  it.each([
    ['DATABASE_SSL', 'yes'],
    ['DATABASE_LOGGING', '1'],
    ['DATABASE_POOL_MAX', '0'],
    ['DATABASE_POOL_MAX', '500'],
    ['DATABASE_PORT', 'postgres'],
  ])('rejects invalid %s=%s', (name, value) => {
    process.env[name] = value;

    expect(() => databaseConfig()).toThrow(ConfigValidationError);
  });
});
