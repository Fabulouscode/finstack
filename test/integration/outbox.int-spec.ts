import { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { jobsConfig } from '../../src/config/jobs.config';
import { RETENTION } from '../../src/maintenance/maintenance.service';
import {
  OutboxEvent,
  OutboxEventStatus,
} from '../../src/outbox/outbox-event.entity';
import { OutboxPublisher } from '../../src/outbox/outbox-publisher';
import { OutboxRelay } from '../../src/outbox/outbox-relay.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { createTestModule } from '../utils/create-test-module';
import { resetDatabase } from '../utils/database';

const config = {
  workersEnabled: false,
  outboxPollIntervalMs: 100,
  webhookMaxAttempts: 5,
  webhookRetryBackoffMs: 200,
} satisfies ReturnType<typeof jobsConfig>;

class RecordingPublisher implements OutboxPublisher {
  readonly published: string[] = [];
  failNext = 0;

  async publish(event: OutboxEvent): Promise<void> {
    // Yield so concurrent relays genuinely interleave.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Redis unavailable');
    }
    this.published.push(event.id);
  }
}

describe('Outbox (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let outbox: OutboxService;

  const addEvents = (count: number): Promise<void> =>
    dataSource.transaction(async (manager) => {
      for (let i = 0; i < count; i++) {
        await outbox.add(manager, {
          type: 'test.happened',
          aggregateType: 'test',
          aggregateId: '00000000-0000-4000-8000-000000000000',
          payload: { i },
        });
      }
    });

  beforeAll(async () => {
    moduleRef = await createTestModule([
      TypeOrmModule.forFeature([OutboxEvent]),
    ]);
    dataSource = moduleRef.get(DataSource);
    outbox = new OutboxService();
  });

  beforeEach(() => resetDatabase(dataSource));

  afterAll(() => moduleRef.close());

  it('records nothing when the surrounding transaction rolls back', async () => {
    await expect(
      dataSource.transaction(async (manager) => {
        await outbox.add(manager, {
          type: 'payment.successful',
          aggregateType: 'transaction',
          aggregateId: '00000000-0000-4000-8000-000000000000',
          payload: {},
        });
        throw new Error('ledger posting failed');
      }),
    ).rejects.toThrow('ledger posting failed');

    await expect(dataSource.getRepository(OutboxEvent).count()).resolves.toBe(
      0,
    );
  });

  it('publishes every event exactly once across concurrent relays (SKIP LOCKED)', async () => {
    await addEvents(60);
    const publisher = new RecordingPublisher();
    const relays = Array.from(
      { length: 4 },
      () => new OutboxRelay(dataSource, publisher, config),
    );

    // Several relay "instances" draining the same outbox at the same time.
    for (let round = 0; round < 5; round++) {
      await Promise.all(relays.map((relay) => relay.tick()));
    }

    expect(publisher.published).toHaveLength(60);
    expect(new Set(publisher.published).size).toBe(60);
    await expect(
      dataSource
        .getRepository(OutboxEvent)
        .countBy({ status: OutboxEventStatus.Pending }),
    ).resolves.toBe(0);
  });

  it('keeps events pending and backs off when publishing fails', async () => {
    await addEvents(1);
    const publisher = new RecordingPublisher();
    publisher.failNext = 1;
    const relay = new OutboxRelay(dataSource, publisher, config);

    await expect(relay.tick()).resolves.toBe(0);

    const [event] = await dataSource.getRepository(OutboxEvent).find();
    expect(event).toMatchObject({
      status: OutboxEventStatus.Pending,
      publishAttempts: 1,
      lastError: 'Error: Redis unavailable',
    });
    expect(event?.availableAt.getTime()).toBeGreaterThan(Date.now());

    // Not retried before its backoff elapses...
    await expect(relay.tick()).resolves.toBe(0);
    // ...and published once it has.
    await dataSource.query(`UPDATE outbox_events SET available_at = now()`);
    await expect(relay.tick()).resolves.toBe(1);
  });

  it('cleans up long-published events', async () => {
    await addEvents(2);
    await dataSource.query(
      `UPDATE outbox_events SET status = 'published', published_at = now() - interval '8 days'`,
    );

    await expect(
      outbox.deletePublishedWithin(
        dataSource.manager,
        RETENTION.outboxEventsDays,
      ),
    ).resolves.toBe(2);
    await expect(dataSource.getRepository(OutboxEvent).count()).resolves.toBe(
      0,
    );
  });
});
