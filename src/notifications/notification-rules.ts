import type { DomainEventMessage } from '../outbox/outbox.service';
import { formatMoney } from './email-templates';

/** Who gets an email for an event, and what it says. */
export interface NotificationRule {
  template: string;
  /** A user, or the owners and admins of an organization. */
  to: { userId: string } | { organizationAdminsOf: string };
  subject: string;
  paragraphs: string[];
  reference?: string;
}

type Money = { amount?: string; currency?: string } | undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const money = (value: Money): string =>
  value?.amount && value.currency
    ? formatMoney(value.amount, value.currency)
    : '';

/**
 * The emails each domain event produces. Organization-owned money events
 * reach organizations through webhooks; only payout problems are also
 * emailed to their owners and admins.
 */
export function notificationRules(
  event: DomainEventMessage,
): NotificationRule[] {
  const data = event.data as Record<string, unknown>;
  const userId = str(data.userId);
  const organizationId = str(data.organizationId);
  const reference = str(data.reference);
  const payoutAmount =
    typeof data.amount === 'string' && typeof data.currency === 'string'
      ? formatMoney(data.amount, data.currency)
      : '';

  switch (event.type) {
    case 'payment.successful': {
      if (!userId) return [];
      const availableAt = str(data.fundsAvailableAt);
      const later =
        availableAt && new Date(availableAt).getTime() > Date.now() + 60_000;
      return [
        {
          template: 'payment_received',
          to: { userId },
          subject: `Payment received: ${money(data.credited as Money)}`,
          paragraphs: [
            `We received your payment of ${money(data.charged as Money)}. ${money(data.credited as Money)} was added to your wallet.`,
            ...(later
              ? [
                  `It will be available to spend from ${new Date(availableAt).toUTCString()}.`,
                ]
              : []),
          ],
          reference,
        },
      ];
    }

    case 'refund.successful':
      if (!userId) return [];
      return [
        {
          template: 'refund_sent',
          to: { userId },
          subject: `Refund sent: ${money(data.refunded as Money)}`,
          paragraphs: [
            `A refund of ${money(data.refunded as Money)} was sent to the customer. ${money(data.walletDebit as Money)} was taken from your wallet.`,
          ],
          reference,
        },
      ];

    case 'payout.successful':
      if (!userId) return [];
      return [
        {
          template: 'payout_sent',
          to: { userId },
          subject: `Withdrawal sent: ${payoutAmount}`,
          paragraphs: [
            `Your withdrawal of ${payoutAmount} has been sent to your bank account.`,
          ],
          reference,
        },
      ];

    case 'payout.failed':
    case 'payout.reversed': {
      const reversed = event.type === 'payout.reversed';
      const rule = {
        template: reversed ? 'payout_reversed' : 'payout_failed',
        subject: reversed
          ? `Withdrawal returned: ${payoutAmount}`
          : `Withdrawal failed: ${payoutAmount}`,
        paragraphs: [
          reversed
            ? `Your withdrawal of ${payoutAmount} was returned by the bank and credited back to the wallet.`
            : `Your withdrawal of ${payoutAmount} could not be completed. The money is back in the wallet.`,
          'Please check the bank account details before trying again.',
        ],
        reference,
      };
      if (userId) return [{ ...rule, to: { userId } }];
      if (organizationId) {
        return [{ ...rule, to: { organizationAdminsOf: organizationId } }];
      }
      return [];
    }

    case 'transfer.completed': {
      const amount =
        typeof data.amount === 'string' && typeof data.currency === 'string'
          ? formatMoney(data.amount, data.currency)
          : '';
      const sender = str(data.senderUserId);
      const recipient = str(data.recipientUserId);
      return [
        ...(sender
          ? [
              {
                template: 'transfer_sent',
                to: { userId: sender },
                subject: `You sent ${amount}`,
                paragraphs: [`Your transfer of ${amount} was completed.`],
                reference,
              },
            ]
          : []),
        ...(recipient
          ? [
              {
                template: 'transfer_received',
                to: { userId: recipient },
                subject: `You received ${amount}`,
                paragraphs: [`${amount} was added to your wallet.`],
                reference,
              },
            ]
          : []),
      ];
    }

    default:
      return [];
  }
}
