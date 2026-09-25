import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Owner, ownerColumns, ownerWhere } from '../common/owner/owner';
import { idempotencyConfig } from '../config/idempotency.config';
import type { IdempotencyConfig } from '../config/idempotency.config';
import { IdempotencyKey, IdempotencyKeyStatus } from './idempotency-key.entity';
import {
  IdempotencyKeyReusedException,
  IdempotencyRequestInProgressException,
} from './idempotency.errors';

export interface RequestFingerprint {
  owner: Owner;
  key: string;
  method: string;
  path: string;
  requestHash: string;
}

export type BeginOutcome =
  | { kind: 'execute'; recordId: string }
  | { kind: 'replay'; status: number; body: object | null };

@Injectable()
export class IdempotencyService {
  constructor(
    @InjectRepository(IdempotencyKey)
    private readonly keys: Repository<IdempotencyKey>,
    @Inject(idempotencyConfig.KEY)
    private readonly config: IdempotencyConfig,
  ) {}

  /**
   * Claims the key for this request, or explains why it can't be executed.
   * The unique (owner, key) index makes the claim atomic: of concurrent
   * requests with one key, exactly one gets `execute`.
   */
  async begin(request: RequestFingerprint): Promise<BeginOutcome> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const recordId = await this.tryInsert(request);
      if (recordId) {
        return { kind: 'execute', recordId };
      }

      const existing = await this.keys.findOneBy({
        ...ownerWhere(request.owner),
        key: request.key,
      });
      if (!existing) {
        continue; // Released or expired concurrently; try to claim again.
      }
      if (existing.expiresAt.getTime() <= Date.now()) {
        await this.keys.delete({
          id: existing.id,
          expiresAt: LessThan(new Date()),
        });
        continue;
      }
      if (
        existing.requestHash !== request.requestHash ||
        existing.method !== request.method ||
        existing.path !== request.path
      ) {
        throw new IdempotencyKeyReusedException();
      }
      if (existing.status === IdempotencyKeyStatus.Completed) {
        return {
          kind: 'replay',
          status: existing.responseStatus ?? 200,
          body: existing.responseBody,
        };
      }
      if (await this.takeOverStale(existing.id)) {
        return { kind: 'execute', recordId: existing.id };
      }
      throw new IdempotencyRequestInProgressException();
    }
    throw new IdempotencyRequestInProgressException();
  }

  async complete(
    recordId: string,
    status: number,
    body: object | null,
  ): Promise<void> {
    await this.keys.update(
      { id: recordId, status: IdempotencyKeyStatus.Processing },
      {
        status: IdempotencyKeyStatus.Completed,
        responseStatus: status,
        responseBody: body,
        completedAt: new Date(),
      },
    );
  }

  /**
   * Frees the key after a failed request. Failures roll back their database
   * transaction, so nothing happened and the client may safely retry.
   */
  async release(recordId: string): Promise<void> {
    await this.keys.delete({
      id: recordId,
      status: IdempotencyKeyStatus.Processing,
    });
  }

  private async tryInsert(request: RequestFingerprint): Promise<string | null> {
    const now = Date.now();
    const result = await this.keys
      .createQueryBuilder()
      .insert()
      .into(IdempotencyKey)
      .values({
        ...ownerColumns(request.owner),
        key: request.key,
        method: request.method,
        path: request.path,
        requestHash: request.requestHash,
        status: IdempotencyKeyStatus.Processing,
        responseStatus: null,
        responseBody: null,
        lockedAt: new Date(now),
        expiresAt: new Date(now + this.config.ttlMs),
        completedAt: null,
      })
      .orIgnore()
      .returning(['id'])
      .execute();

    const row = result.raw as { id: string }[];
    return row[0]?.id ?? null;
  }

  /** Claims an in-progress key whose attempt has been silent for too long. */
  private async takeOverStale(recordId: string): Promise<boolean> {
    const result = await this.keys
      .createQueryBuilder()
      .update(IdempotencyKey)
      .set({ lockedAt: () => 'now()' })
      .where('id = :id', { id: recordId })
      .andWhere('status = :status', { status: IdempotencyKeyStatus.Processing })
      .andWhere('locked_at < now() - make_interval(secs => :timeout)', {
        timeout: this.config.lockTimeoutMs / 1000,
      })
      .execute();

    return (result.affected ?? 0) > 0;
  }
}
