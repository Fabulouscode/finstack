import { formatMoney } from '../common/money/format';

export { formatMoney };

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
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
