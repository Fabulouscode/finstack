import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ALLOW_API_KEY,
  API_KEY_HEADER_NAME,
} from '../../api-keys/api-key-principal';
import {
  ApiKeyNotAllowedException,
  InvalidApiKeyException,
} from '../../api-keys/api-keys.errors';
import { ApiKeysService } from '../../api-keys/api-keys.service';
import { AuthenticationRequiredException } from '../auth.errors';
import { AuthenticatedRequest } from '../authenticated-user';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AccessTokenService } from '../tokens/access-token.service';

/**
 * Registered globally: every route requires a valid Bearer access token
 * unless marked @Public(). Forgetting a decorator fails closed. An
 * `X-API-Key` is accepted instead only on routes marked @AllowApiKey().
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
    private readonly apiKeys: ApiKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // API keys are accepted only where a route explicitly allows them.
    const presentedKey = request.header(API_KEY_HEADER_NAME);
    if (presentedKey !== undefined) {
      const allowsApiKey = this.reflector.getAllAndOverride<
        boolean | undefined
      >(ALLOW_API_KEY, [context.getHandler(), context.getClass()]);
      if (!allowsApiKey) {
        throw new ApiKeyNotAllowedException();
      }
      const principal = await this.apiKeys.authenticate(presentedKey);
      if (!principal) {
        throw new InvalidApiKeyException();
      }
      request.apiKey = principal;
      return true;
    }

    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new AuthenticationRequiredException();
    }

    const user = await this.accessTokens.verify(token);
    if (!user) {
      throw new AuthenticationRequiredException(
        'Access token is invalid or expired',
      );
    }

    request.user = user;
    return true;
  }
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
    return null;
  }
  return token;
}
