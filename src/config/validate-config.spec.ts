import { Type } from 'class-transformer';
import { IsInt, IsString, Min } from 'class-validator';
import { ConfigValidationError, validateConfig } from './validate-config';

class TestSchema {
  @IsString()
  NAME: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  COUNT: number = 5;
}

describe('validateConfig', () => {
  it('returns a typed instance with values converted', () => {
    const config = validateConfig('test', TestSchema, {
      NAME: 'finstack',
      COUNT: '10',
    });

    expect(config).toBeInstanceOf(TestSchema);
    expect(config.NAME).toBe('finstack');
    expect(config.COUNT).toBe(10);
  });

  it('applies class defaults for missing optional values', () => {
    const config = validateConfig('test', TestSchema, { NAME: 'finstack' });

    expect(config.COUNT).toBe(5);
  });

  it('strips variables not declared on the schema', () => {
    const config = validateConfig('test', TestSchema, {
      NAME: 'finstack',
      UNRELATED_SECRET: 'should-not-leak',
    });

    expect(config).not.toHaveProperty('UNRELATED_SECRET');
  });

  it('reports every violation in a single error', () => {
    const attempt = (): TestSchema =>
      validateConfig('test', TestSchema, { COUNT: 'not-a-number' });

    expect(attempt).toThrow(ConfigValidationError);

    try {
      attempt();
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(validationError.namespace).toBe('test');
      expect(validationError.violations).toHaveLength(2);
      expect(validationError.message).toContain('NAME');
      expect(validationError.message).toContain('COUNT');
    }
  });
});
