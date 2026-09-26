import { CURRENCIES, isSupportedCurrency } from '../common/money/currency';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** `150000`, `NGN` -> `NGN 1,500.00`. */
export function formatMoney(
  minorUnits: string | bigint,
  currency: string,
): string {
  const exponent = isSupportedCurrency(currency)
    ? CURRENCIES[currency].minorUnits
    : 2;
  const value = BigInt(minorUnits);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(exponent);
  const whole = (abs / scale).toLocaleString('en-US');
  const fraction =
    exponent > 0 ? `.${(abs % scale).toString().padStart(exponent, '0')}` : '';
  return `${currency} ${negative ? '-' : ''}${whole}${fraction}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A plain, accessible email. Paragraphs are text (escaped for HTML), so
 * nothing from event data can inject markup.
 */
export function renderEmail(
  subject: string,
  greetingName: string | null,
  paragraphs: string[],
  reference?: string,
): RenderedEmail {
  const lines = [
    greetingName ? `Hi ${greetingName},` : 'Hello,',
    ...paragraphs,
    ...(reference ? [`Reference: ${reference}`] : []),
  ];
  return {
    subject,
    text: `${lines.join('\n\n')}\n`,
    html:
      '<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">' +
      lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('') +
      '</body></html>',
  };
}
