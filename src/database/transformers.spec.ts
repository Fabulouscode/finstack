import { bigintTransformer } from './transformers';

describe('bigintTransformer', () => {
  it('reads PostgreSQL bigint strings without precision loss', () => {
    expect(bigintTransformer.from('9223372036854775807')).toBe(
      9223372036854775807n,
    );
    expect(bigintTransformer.from(null)).toBeNull();
  });

  it('writes bigints as strings', () => {
    expect(bigintTransformer.to(150000n)).toBe('150000');
    expect(bigintTransformer.to(null)).toBeNull();
  });
});
