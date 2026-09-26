import { formatMoney, renderEmail } from './email-templates';

describe('email templates', () => {
  it.each([
    ['150000', 'NGN', 'NGN 1,500.00'],
    ['2550', 'USD', 'USD 25.50'],
    ['5', 'USD', 'USD 0.05'],
    ['500', 'JPY', 'JPY 500'],
    [123456789n, 'USD', 'USD 1,234,567.89'],
  ])('formats %s %s as %s', (amount, currency, expected) => {
    expect(formatMoney(amount, currency)).toBe(expected);
  });

  it('escapes event data in HTML', () => {
    const email = renderEmail('Subject', '<b>Ada</b>', [
      'Paid <script>x</script>',
    ]);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;b&gt;Ada&lt;/b&gt;');
    expect(email.text).toContain('Hi <b>Ada</b>,');
  });
});
