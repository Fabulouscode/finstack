import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../users/user.entity';
import { AuthenticationRequiredException } from '../auth.errors';
import { AuthenticatedRequest } from '../authenticated-user';
import type { ApiKeyPrincipal } from '../../api-keys/api-key-principal';
import {
  ApiKeyNotAllowedException,
  InvalidApiKeyException,
} from '../../api-keys/api-keys.errors';
import { ApiKeysService } from '../../api-keys/api-keys.service';
import { AccessTokenService } from '../tokens/access-token.service';
import { extractBearerToken, JwtAuthGuard } from './jwt-auth.guard';

function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
  // Mutate the given object so tests can inspect what the guard attached.
  const withHeader = Object.assign(request, {
    header: (name: string): string | undefined => {
      const value = request.headers?.[name.toLowerCase()];
      return typeof value === 'string' ? value : undefined;
    },
  });
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => withHeader }),
  } as unknown as ExecutionContext;
}

describe('extractBearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc', 'abc'],
    [undefined, null],
    ['', null],
    ['Basic dXNlcjpwYXNz', null],
    ['Bearer', null],
    ['Bearer a b', null],
  ])('%s -> %s', (header, expected) => {
    expect(extractBearerToken(header)).toBe(expected);
  });
});

describe('JwtAuthGuard', () => {
  const user = { id: 'user-1', role: UserRole.User };
  const verify = jest.fn<Promise<typeof user | null>, [string]>();
  const accessTokens = { verify } as unknown as AccessTokenService;
  const authenticate = jest.fn<Promise<ApiKeyPrincipal | null>, [string]>();
  const apiKeys = { authenticate } as unknown as ApiKeysService;
  const reflector = new Reflector();
  const guard = new JwtAuthGuard(reflector, accessTokens, apiKeys);

  /** Metadata lookups in the guard: first @Public(), then @AllowApiKey(). */
  const routeMetadata = (
    isPublic: boolean | undefined,
    allowsApiKey?: boolean,
  ): void => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValueOnce(isPublic)
      .mockReturnValueOnce(allowsApiKey);
  };

  beforeEach(() => {
    verify.mockReset();
    authenticate.mockReset();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
  });

  describe('API keys', () => {
    const principal: ApiKeyPrincipal = {
      id: 'key-1',
      organizationId: 'org-1',
      scopes: ['wallets:read'],
    };
    const keyRequest = (): Partial<AuthenticatedRequest> => ({
      headers: { 'x-api-key': 'fsk_test_1a2b3c4d_secret' },
    });

    it('rejects a key on routes that do not allow API keys', async () => {
      routeMetadata(undefined, undefined);

      await expect(guard.canActivate(contextFor(keyRequest()))).rejects.toThrow(
        ApiKeyNotAllowedException,
      );
      expect(authenticate).not.toHaveBeenCalled();
    });

    it('attaches the principal for a valid key on allowed routes', async () => {
      routeMetadata(undefined, true);
      authenticate.mockResolvedValue(principal);
      const request = keyRequest();

      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
      expect(authenticate).toHaveBeenCalledWith('fsk_test_1a2b3c4d_secret');
    });

    it('rejects an invalid key on allowed routes', async () => {
      routeMetadata(undefined, true);
      authenticate.mockResolvedValue(null);

      await expect(guard.canActivate(contextFor(keyRequest()))).rejects.toThrow(
        InvalidApiKeyException,
      );
    });
  });

  it('lets @Public() routes through without a token', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

    await expect(guard.canActivate(contextFor({ headers: {} }))).resolves.toBe(
      true,
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects a request without a bearer token', async () => {
    await expect(
      guard.canActivate(contextFor({ headers: {} })),
    ).rejects.toThrow(AuthenticationRequiredException);
  });

  it('rejects an invalid token', async () => {
    verify.mockResolvedValue(null);

    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: 'Bearer bad' } }),
      ),
    ).rejects.toThrow(AuthenticationRequiredException);
  });

  it('attaches the user for a valid token', async () => {
    verify.mockResolvedValue(user);
    const request: Partial<AuthenticatedRequest> = {
      headers: { authorization: 'Bearer good' },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('good');
    expect(request.user).toEqual(user);
  });
});
