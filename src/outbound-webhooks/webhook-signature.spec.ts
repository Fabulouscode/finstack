import {
  generateWebhookSecret,
  signatureHeader,
  verifySignatureHeader,
} from './webhook-signature';

describe('webhook signatures', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'payment.successful' });

  it('verifies with any active secret during a rotation', () => {
    const [current, previous] = [
      generateWebhookSecret(),
      generateWebhookSecret(),
    ];
    const header = signatureHeader([current, previous], body);
    expect(verifySignatureHeader(header, current, body)).toBe(true);
    expect(verifySignatureHeader(header, previous, body)).toBe(true);
    expect(verifySignatureHeader(header, generateWebhookSecret(), body)).toBe(
      false,
    );
  });

  it('rejects a modified body and an old timestamp', () => {
    const secret = generateWebhookSecret();
    const header = signatureHeader([secret], body);
    expect(verifySignatureHeader(header, secret, `${body} `)).toBe(false);

    const old = signatureHeader(
      [secret],
      body,
      Math.floor(Date.now() / 1000) - 600,
    );
    expect(verifySignatureHeader(old, secret, body)).toBe(false);
  });
});
