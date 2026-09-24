import { Test } from '@nestjs/testing';
import { ConfigModule } from '../src/config/config.module';

describe('Config (e2e)', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  // Boots only ConfigModule: compiling the full AppModule here would open a
  // database pool before validation fails, leaving it with no one to close it.
  it('refuses to boot with invalid configuration', async () => {
    process.env = { ...originalEnv, PORT: 'not-a-port' };

    await expect(
      Test.createTestingModule({ imports: [ConfigModule] }).compile(),
    ).rejects.toThrow(/Invalid "app" configuration[\s\S]*PORT/);
  });
});
