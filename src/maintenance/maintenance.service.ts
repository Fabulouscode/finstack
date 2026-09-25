import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface CleanupResult {
  idempotencyKeys: number;
  refreshTokens: number;
  outboxEvents: number;
}

/** Retention for rows that are only kept for a while after they stop mattering. */
export const RETENTION = {
  /** Refresh tokens kept after expiry/revocation, for reuse detection and audit. */
  refreshTokensDays: 30,
  /** Published outbox events kept for debugging. */
  outboxEventsDays: 7,
} as const;

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Deletes expired or long-finished rows. Idempotent; safe to run anytime. */
  async cleanup(): Promise<CleanupResult> {
    const [idempotencyKeys, refreshTokens, outboxEvents] = await Promise.all([
      this.deleteCount(`DELETE FROM idempotency_keys WHERE expires_at < now()`),
      this.deleteCount(
        `DELETE FROM refresh_tokens
          WHERE (expires_at < now() - make_interval(days => $1))
             OR (revoked_at < now() - make_interval(days => $1))`,
        [RETENTION.refreshTokensDays],
      ),
      this.deleteCount(
        `DELETE FROM outbox_events
          WHERE status = 'published' AND published_at < now() - make_interval(days => $1)`,
        [RETENTION.outboxEventsDays],
      ),
    ]);

    const result = { idempotencyKeys, refreshTokens, outboxEvents };
    this.logger.log(`Cleanup removed ${JSON.stringify(result)}`);
    return result;
  }

  private async deleteCount(
    sql: string,
    params: unknown[] = [],
  ): Promise<number> {
    const [, affected] = await this.dataSource.query<[unknown[], number]>(
      sql,
      params,
    );
    return affected ?? 0;
  }
}
