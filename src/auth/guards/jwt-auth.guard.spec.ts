import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../users/user.entity';
import { AuthenticationRequiredException } from '../auth.errors';
import { AuthenticatedRequest } from '../authenticated-user';
import { AccessTokenService } from '../tokens/access-token.service';
import { extractBearerToken, JwtAuthGuard } from './jwt-auth.guard';

function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
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
  const reflector = new Reflector();
  const guard = new JwtAuthGuard(reflector, accessTokens);

  beforeEach(() => {
    verify.mockReset();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
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
