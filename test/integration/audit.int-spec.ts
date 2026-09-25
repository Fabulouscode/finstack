import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AuditAction } from '../../src/audit/audit-actions';
import { AuditLog } from '../../src/audit/audit-log.entity';
import { AuditService } from '../../src/audit/audit.service';
import { RequestContext } from '../../src/common/request-context/request-context';
import { createTestModule } from '../utils/create-test-module';
import { resetDatabase } from '../utils/database';

const USER_ID = '0b9f7c4e-2f8a-4d5e-9c1b-7a6e5d4c3b2a';
const KEY_ID = '1c8e6d5f-3a9b-4e6f-8d2c-6b5a4e3d2c1b';
const ORG_ID = '2d7f5e6a-4b8c-4f7a-9e3d-5c4b3a2e1d0c';

describe('AuditService (integration)', () => {
  let moduleRef: TestingModule;
  let audit: AuditService;
  let dataSource: DataSource;

  beforeAll(async () => {
    moduleRef = await createTestModule([]);
    audit = moduleRef.get(AuditService);
    dataSource = moduleRef.get(DataSource);
  });

  beforeEach(() => resetDatabase(dataSource));
  afterAll(() => moduleRef.close());

  const entry = {
    action: AuditAction.MemberAdded,
    targetType: 'user',
    targetId: USER_ID,
  };

  it('attributes entries to the request actor, with request id and IP', async () => {
    await RequestContext.run(
      { requestId: 'req-1', ipAddress: '203.0.113.7' },
      async () => {
        RequestContext.setActor({
          type: 'api_key',
          id: KEY_ID,
          organizationId: ORG_ID,
        });
        await audit.record(undefined, entry);
      },
    );

    const [log] = await dataSource.manager.find(AuditLog);
    expect(log).toMatchObject({
      actorType: 'api_key',
      actorId: KEY_ID,
      organizationId: ORG_ID,
      requestId: 'req-1',
      ipAddress: '203.0.113.7',
      metadata: {},
    });
  });

  it('records background work as the system', async () => {
    await audit.record(undefined, entry);

    const [log] = await dataSource.manager.find(AuditLog);
    expect(log).toMatchObject({
      actorType: 'system',
      actorId: null,
      requestId: null,
    });
  });

  it('commits and rolls back with the surrounding transaction', async () => {
    await expect(
      dataSource.transaction(async (manager) => {
        await audit.record(manager, entry);
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');

    await expect(dataSource.manager.count(AuditLog)).resolves.toBe(0);
  });

  it('is append-only in the database', async () => {
    await audit.record(undefined, entry);

    await expect(
      dataSource.query(`UPDATE audit_logs SET action = 'tampered'`),
    ).rejects.toThrow(/immutable/);
    await expect(dataSource.query(`DELETE FROM audit_logs`)).rejects.toThrow(
      /immutable/,
    );
  });

  it('filters and pages newest first', async () => {
    await RequestContext.run({ requestId: 'r' }, async () => {
      RequestContext.setActor({ type: 'user', id: USER_ID });
      for (let i = 0; i < 3; i++) {
        await audit.record(undefined, { ...entry, organizationId: ORG_ID });
      }
      await audit.record(undefined, {
        ...entry,
        action: AuditAction.WalletCreated,
      });
    });

    const first = await audit.list({ organizationId: ORG_ID }, { limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const second = await audit.list(
      { organizationId: ORG_ID },
      { limit: 2, before: first.next ?? undefined },
    );
    expect(second.entries).toHaveLength(1);
    expect(second.next).toBeNull();

    const ids = [...first.entries, ...second.entries].map((log) => log.id);
    expect(new Set(ids).size).toBe(3);

    const wallets = await audit.list(
      { action: AuditAction.WalletCreated, actorId: USER_ID },
      { limit: 10 },
    );
    expect(wallets.entries).toHaveLength(1);
  });
});
