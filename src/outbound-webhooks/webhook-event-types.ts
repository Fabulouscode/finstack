/**
 * Events an organization can subscribe to. Each comes from the outbox with
 * the organization in its payload; the payload is sent as `data`.
 */
export const WEBHOOK_EVENT_TYPES = [
  'payment.successful',
  'payment.failed',
  'payment.funds_available',
  'refund.successful',
  'refund.failed',
  'payout.successful',
  'payout.failed',
  'payout.reversed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Sent by the "test" endpoint; never produced by the system. */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

/** Subscribes to every event type, including ones added later. */
export const ALL_EVENTS = '*';
