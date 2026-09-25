import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { IsNull, LessThan, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { appConfig } from '../config/app.config';
import type { AppConfig } from '../config/app.config';
import {
  OrgPermission,
  OrgRole,
  roleHasPermission,
} from '../organizations/organization-permissions';
import { OrganizationStatus } from '../organizations/organization.entity';
import { OrganizationsService } from '../organizations/organizations.service';
import { ApiKeyPrincipal } from './api-key-principal';
import { ApiKey } from './api-key.entity';
import {
  ApiKeyNotFoundException,
  ApiKeyScopeNotGrantableException,
} from './api-keys.errors';

const LAST_USED_RESOLUTION_MS = 60_000;
const KEY_FORMAT = /^fsk_(test|live)_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

@Injectable()
export class ApiKeysService {
  constructor(
    @InjectRepository(ApiKey) private readonly keys: Repository<ApiKey>,
    private readonly organizations: OrganizationsService,
    @Inject(appConfig.KEY) private readonly app: AppConfig,
    private readonly audit: AuditService,
  ) {}

  /**
   * Issues a key. Returns the secret once; only its hash is stored. The
   * creator can't grant scopes their own role doesn't have.
   */
  async create(input: {
    organizationId: string;
    creatorId: string;
    creatorRole: OrgRole;
    name: string;
    scopes: OrgPermission[];
    expiresAt?: Date;
  }): Promise<{ apiKey: ApiKey; secret: string }> {
    const scopes = [...new Set(input.scopes)];
    const notGrantable = scopes.filter(
      (scope) => !roleHasPermission(input.creatorRole, scope),
    );
    if (notGrantable.length > 0) {
      throw new ApiKeyScopeNotGrantableException(notGrantable);
    }

    const environment = this.app.isProduction ? 'live' : 'test';
    const id = randomBytes(4).toString('hex');
    const secret = `fsk_${environment}_${id}_${randomBytes(32).toString('base64url')}`;

    const apiKey = await this.keys.manager.transaction(async (manager) => {
      const saved = await manager.save(
        manager.create(ApiKey, {
          organizationId: input.organizationId,
          name: input.name,
          prefix: `fsk_${environment}_${id}`,
          keyHash: hashApiKey(secret),
          scopes,
          createdByUserId: input.creatorId,
          lastUsedAt: null,
          expiresAt: input.expiresAt ?? null,
          revokedAt: null,
        }),
      );
      await this.audit.record(manager, {
        action: AuditAction.ApiKeyCreated,
        organizationId: input.organizationId,
        targetType: 'api_key',
        targetId: saved.id,
        metadata: {
          name: saved.name,
          prefix: saved.prefix,
          scopes,
          expiresAt: saved.expiresAt,
        },
      });
      return saved;
    });
    return { apiKey, secret };
  }

  list(organizationId: string): Promise<ApiKey[]> {
    return this.keys.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
    });
  }

  async revoke(organizationId: string, apiKeyId: string): Promise<void> {
    const result = await this.keys.manager.transaction(async (manager) => {
      const updated = await manager.update(
        ApiKey,
        { id: apiKeyId, organizationId, revokedAt: IsNull() },
        { revokedAt: new Date() },
      );
      if (updated.affected) {
        await this.audit.record(manager, {
          action: AuditAction.ApiKeyRevoked,
          organizationId,
          targetType: 'api_key',
          targetId: apiKeyId,
        });
      }
      return updated;
    });
    if (!result.affected) {
      const exists = await this.keys.existsBy({ id: apiKeyId, organizationId });
      if (!exists) throw new ApiKeyNotFoundException();
    }
  }

  /** Returns the principal for a valid, active key of an active organization. */
  async authenticate(presented: string): Promise<ApiKeyPrincipal | null> {
    if (!KEY_FORMAT.test(presented)) {
      return null;
    }
    const apiKey = await this.keys.findOneBy({
      keyHash: hashApiKey(presented),
    });
    const now = Date.now();
    if (
      !apiKey ||
      apiKey.revokedAt !== null ||
      (apiKey.expiresAt !== null && apiKey.expiresAt.getTime() <= now)
    ) {
      return null;
    }
    const organization = await this.organizations.get(apiKey.organizationId);
    if (organization.status !== OrganizationStatus.Active) {
      return null;
    }

    // Coarse last-used tracking: at most one write per key per minute.
    if (
      !apiKey.lastUsedAt ||
      now - apiKey.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS
    ) {
      await this.keys.update(
        { id: apiKey.id, lastUsedAt: IsNull() },
        { lastUsedAt: new Date(now) },
      );
      await this.keys.update(
        {
          id: apiKey.id,
          lastUsedAt: LessThan(new Date(now - LAST_USED_RESOLUTION_MS)),
        },
        { lastUsedAt: new Date(now) },
      );
    }

    return {
      id: apiKey.id,
      organizationId: apiKey.organizationId,
      scopes: apiKey.scopes,
    };
  }
}
