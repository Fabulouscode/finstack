/** BullMQ queues. Each has one responsibility and its own retry policy. */
export const QueueName = {
  /** Settles verified provider webhooks (retries with exponential backoff). */
  Webhooks: 'webhooks',
  /** Delivers domain events (payment.successful, ...) to their handlers. */
  DomainEvents: 'domain-events',
  /** Periodic housekeeping (expired keys, old outbox rows). */
  Maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const ALL_QUEUES: QueueName[] = Object.values(QueueName);
