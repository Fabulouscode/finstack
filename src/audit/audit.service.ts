import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import type { Cursor } from '../common/pagination/cursor';
import {
  Actor,
  RequestContext,
} from '../common/request-context/request-context';
import { AuditActionName } from './audit-actions';
import { AuditActorType, AuditLog } from './audit-log.entity';

export interface AuditEntry {
  action: AuditActionName;
  targetType: string;
  targetId: string;
  organizationId?: string | null;
  metadata?: Record<string, unknown>;
  /** Defaults to the request's authenticated principal (or `system`). */
  actor?: Actor;
}

export interface AuditFilter {
  organizationId?: string;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
}

export interface AuditPage {
  entries: AuditLog[];
  next: Cursor | null;
}

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog) private readonly logs: Repository<AuditLog>,
  ) {}

  /**
   * Records an action. Pass the transaction's `manager` so the entry commits
   * (or rolls back) together with the change it describes.
   */
  async record(
    manager: EntityManager | undefined,
    entry: AuditEntry,
  ): Promise<void> {
    const actor = entry.actor ?? RequestContext.actor();
    const context = RequestContext.current();
    const organizationId =
      entry.organizationId ??
      (actor.type === 'api_key' ? actor.organizationId : null);

    const target = manager ?? this.logs.manager;
    await target.save(
      target.create(AuditLog, {
        actorType: actor.type as AuditActorType,
        actorId: actor.type === 'system' ? null : actor.id,
        organizationId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: entry.metadata ?? {},
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress?.slice(0, 64) ?? null,
      }),
    );
  }

  /** Newest first, keyset-paginated. */
  async list(
    filter: AuditFilter,
    options: { limit: number; before?: Cursor },
  ): Promise<AuditPage> {
    const query = this.logs
      .createQueryBuilder('log')
      .orderBy('log.createdAt', 'DESC')
      .addOrderBy('log.id', 'DESC')
      .limit(options.limit + 1);

    for (const [field, value] of Object.entries(filter) as [
      string,
      string | undefined,
    ][]) {
      if (value !== undefined) {
        query.andWhere(`log.${field} = :${field}`, { [field]: value });
      }
    }
    if (options.before) {
      query.andWhere(
        '(log.createdAt, log.id) < (:beforeCreatedAt, :beforeId)',
        {
          beforeCreatedAt: options.before.createdAt,
          beforeId: options.before.id,
        },
      );
    }

    const rows = await query.getMany();
    const entries = rows.slice(0, options.limit);
    const last = entries.at(-1);
    return {
      entries,
      next:
        rows.length > options.limit && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }
}
