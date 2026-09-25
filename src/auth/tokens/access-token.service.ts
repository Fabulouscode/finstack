import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { authConfig } from '../../config/auth.config';
import type { AuthConfig } from '../../config/auth.config';
import { UserRole } from '../../users/user.entity';
import { AuthenticatedUser } from '../authenticated-user';

interface AccessTokenPayload {
  sub?: unknown;
  role?: unknown;
}

const ROLES = new Set<string>(Object.values(UserRole));

@Injectable()
export class AccessTokenService {
  private readonly logger = new Logger(AccessTokenService.name);

  constructor(
    private readonly jwt: JwtService,
    @Inject(authConfig.KEY)
    private readonly config: AuthConfig,
  ) {}

  get ttlSeconds(): number {
    return this.config.accessToken.ttlSeconds;
  }

  /** Claims are kept minimal: no email or other personal data in the token. */
  sign(user: AuthenticatedUser): Promise<string> {
    return this.jwt.signAsync({ role: user.role }, { subject: user.id });
  }

  /** Returns the identity, or `null` for any invalid, expired or malformed token. */
  async verify(token: string): Promise<AuthenticatedUser | null> {
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch (error) {
      // The reason (e.g. "jwt expired", "invalid signature") stays in the
      // logs; clients only ever see a generic 401. The token is never logged.
      this.reject(
        error instanceof Error ? error.message : 'unverifiable token',
      );
      return null;
    }

    if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') {
      this.reject('missing sub or role claim');
      return null;
    }
    if (!ROLES.has(payload.role)) {
      this.reject(`unknown role "${payload.role}"`);
      return null;
    }

    return { id: payload.sub, role: payload.role as UserRole };
  }

  private reject(reason: string): void {
    this.logger.debug(`Access token rejected: ${reason}`);
  }
}
