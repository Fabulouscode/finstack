import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../users/user.entity';
import { InsufficientRoleException } from '../auth.errors';
import { AuthenticatedUser } from '../authenticated-user';
import { RolesGuard } from './roles.guard';

function contextFor(user?: AuthenticatedUser): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  const requireRoles = (roles: UserRole[] | undefined): void => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
  };

  it('allows routes without @Roles()', () => {
    requireRoles(undefined);

    expect(
      guard.canActivate(contextFor({ id: 'u', role: UserRole.User })),
    ).toBe(true);
  });

  it('allows users holding a required role', () => {
    requireRoles([UserRole.Admin]);

    expect(
      guard.canActivate(contextFor({ id: 'u', role: UserRole.Admin })),
    ).toBe(true);
  });

  it('rejects users without a required role', () => {
    requireRoles([UserRole.Admin]);

    expect(() =>
      guard.canActivate(contextFor({ id: 'u', role: UserRole.User })),
    ).toThrow(InsufficientRoleException);
  });

  it('rejects when no user is attached', () => {
    requireRoles([UserRole.Admin]);

    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      InsufficientRoleException,
    );
  });
});
