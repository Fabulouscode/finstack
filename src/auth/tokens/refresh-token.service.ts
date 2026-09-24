import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { authConfig } from '../../config/auth.config';
import type { AuthConfig } from '../../config/auth.config';
import { InvalidRefreshTokenException } from '../auth.errors';
import { RefreshToken } from './refresh-token.entity';

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

export interface RotatedRefreshToken extends IssuedRefreshToken {
  userId: string;
  familyId: string;
}

type RotationOutcome =
  | { kind: 'rotated'; result: RotatedRefreshToken }
  | { kind: 'invalid' }
  | { kind: 'reused'; userId: string; familyId: string };

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    @InjectRepository(RefreshToken)
    private readonly tokens: Repository<RefreshToken>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(authConfig.KEY)
    private readonly config: AuthConfig,
  ) {}

  /** Starts a new token family (a new login session). */
  issue(userId: string): Promise<IssuedRefreshToken> {
    return this.create(this.tokens.manager, userId, randomUUID());
  }

  /**
   * Exchanges a refresh token for a new one (rotation).
   *
   * The token row is locked with SELECT ... FOR UPDATE, so concurrent
   * refreshes with the same token are serialised: the first rotates it, and
   * the second sees it already revoked. Presenting a revoked token means it
   * was copied, so the whole family is revoked (OAuth 2.0 Security BCP
   * §4.14). The revocation is committed before the error is raised.
   */
  async rotate(token: string): Promise<RotatedRefreshToken> {
    const outcome = await this.dataSource.transaction(
      async (manager): Promise<RotationOutcome> => {
        const current = await manager
          .getRepository(RefreshToken)
          .createQueryBuilder('token')
          .setLock('pessimistic_write')
          .where('token.tokenHash = :tokenHash', {
            tokenHash: hashToken(token),
          })
          .getOne();

        if (!current) {
          return { kind: 'invalid' };
        }
        if (current.revokedAt !== null) {
          await this.revokeFamilyWith(manager, current.familyId);
          return {
            kind: 'reused',
            userId: current.userId,
            familyId: current.familyId,
          };
        }
        if (current.expiresAt.getTime() <= Date.now()) {
          return { kind: 'invalid' };
        }

        const next = await this.create(
          manager,
          current.userId,
          current.familyId,
        );
        await manager.update(RefreshToken, current.id, {
          revokedAt: new Date(),
          replacedById: next.id,
        });

        return {
          kind: 'rotated',
          result: {
            token: next.token,
            expiresAt: next.expiresAt,
            userId: current.userId,
            familyId: current.familyId,
          },
        };
      },
    );

    if (outcome.kind === 'reused') {
      this.logger.warn(
        `Refresh token reuse detected; revoked family ${outcome.familyId} of user ${outcome.userId}`,
      );
    }
    if (outcome.kind !== 'rotated') {
      throw new InvalidRefreshTokenException();
    }
    return outcome.result;
  }

  /** Ends the session the token belongs to. Unknown tokens are ignored (idempotent). */
  async revoke(token: string): Promise<void> {
    const found = await this.tokens.findOneBy({ tokenHash: hashToken(token) });
    if (found) {
      await this.revokeFamily(found.familyId);
    }
  }

  revokeFamily(familyId: string): Promise<void> {
    return this.revokeFamilyWith(this.tokens.manager, familyId);
  }

  /** Ends every session of the user ("sign out everywhere"). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.tokens.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  private async revokeFamilyWith(
    manager: EntityManager,
    familyId: string,
  ): Promise<void> {
    await manager.update(
      RefreshToken,
      { familyId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  private async create(
    manager: EntityManager,
    userId: string,
    familyId: string,
  ): Promise<IssuedRefreshToken & { id: string }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.refreshToken.ttlMs);

    const saved = await manager.save(
      manager.create(RefreshToken, {
        userId,
        familyId,
        tokenHash: hashToken(token),
        expiresAt,
        revokedAt: null,
        replacedById: null,
      }),
    );

    return { id: saved.id, token, expiresAt };
  }
}

/**
 * Refresh tokens are 256-bit random values, so a fast unsalted hash is
 * sufficient: there is nothing to brute-force, and lookup stays O(1).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
