import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ALL_QUEUES } from '../../src/queues/queue-names';

/** Removes every job from every queue, like resetDatabase() for Redis. */
export async function resetQueues(app: INestApplication): Promise<void> {
  await Promise.all(
    ALL_QUEUES.map((name) =>
      app
        .get<Queue>(getQueueToken(name), { strict: false })
        .obliterate({ force: true }),
    ),
  );
}

/** Polls `check` until it passes or `timeoutMs` elapses (for async workers). */
export async function eventually<T>(
  check: () => Promise<T>,
  { timeoutMs = 8_000, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
