import { WebhookUrlPolicy } from './webhook-url-policy';

const policy = (overrides: object = {}): WebhookUrlPolicy =>
  new WebhookUrlPolicy({
    maxAttempts: 3,
    backoffMs: 10,
    timeoutMs: 1_000,
    disableAfterFailures: 5,
    allowPrivateUrls: false,
    requireHttps: true,
    ...overrides,
  });

describe('WebhookUrlPolicy', () => {
  it.each([
    'https://127.0.0.1/hook',
    'https://10.1.2.3/hook',
    'https://172.20.0.1/hook',
    'https://192.168.1.10/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/hook',
    'https://[fd00::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
    'https://localhost/hook',
  ])('refuses private address %s', async (url) => {
    await expect(policy().check(url)).resolves.toMatch(/private|internal/);
  });

  it('accepts a public https address', async () => {
    await expect(
      policy().check('https://93.184.216.34/hook'),
    ).resolves.toBeNull();
  });

  it('requires https and no credentials', async () => {
    await expect(policy().check('http://93.184.216.34/hook')).resolves.toMatch(
      /https/,
    );
    await expect(
      policy().check('https://user:pass@93.184.216.34/hook'),
    ).resolves.toMatch(/credentials/);
    await expect(policy().check('not a url')).resolves.toMatch(/valid/);
  });

  it('allows local http endpoints in development', async () => {
    await expect(
      policy({ allowPrivateUrls: true, requireHttps: false }).check(
        'http://127.0.0.1:4000/hook',
      ),
    ).resolves.toBeNull();
  });
});
