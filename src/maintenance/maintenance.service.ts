import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshTokenService } from '../auth/tokens/refresh-token.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { OutboxService } from '../outbox/outbox.service';

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

/**
 * Housekeeping policy. Each module deletes its own rows; this service only
 * decides when and how long to keep them.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly idempotency: IdempotencyService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly outbox: OutboxService,
  ) {}

  /** Deletes expired or long-finished rows. Idempotent; safe to run anytime. */
  async cleanup(): Promise<CleanupResult> {
    const [idempotencyKeys, refreshTokens, outboxEvents] = await Promise.all([
      this.idempotency.deleteExpired(),
      this.refreshTokens.deleteFinished(RETENTION.refreshTokensDays),
      this.outbox.deletePublishedWithin(
        this.dataSource.manager,
        RETENTION.outboxEventsDays,
      ),
    ]);

    const result = { idempotencyKeys, refreshTokens, outboxEvents };
    this.logger.log(`Cleanup removed ${JSON.stringify(result)}`);
    return result;
  }
}
