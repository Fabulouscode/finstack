import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';

describe('Config (e2e)', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('refuses to boot the application with invalid configuration', async () => {
    process.env = { ...originalEnv, PORT: 'not-a-port' };

    await expect(
      Test.createTestingModule({ imports: [AppModule] }).compile(),
    ).rejects.toThrow(/Invalid "app" configuration[\s\S]*PORT/);
  });
});
