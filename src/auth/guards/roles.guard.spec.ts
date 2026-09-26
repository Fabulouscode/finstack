import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../users/user.entity';
import { InsufficientRoleException } from '../auth.errors';
import { AuthenticatedUser } from '../authenticated-user';
import { PlatformPermission } from '../platform-permissions';
import { PLATFORM_PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
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
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key) => (key === ROLES_KEY ? roles : undefined));
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

describe('RolesGuard with platform permissions', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  const check = (role: UserRole, permission: PlatformPermission): boolean => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key) =>
        key === PLATFORM_PERMISSION_KEY ? permission : undefined,
      );
    return guard.canActivate(contextFor({ id: 'u1', role }));
  };

  it.each([
    [UserRole.Admin, PlatformPermission.ManageRoles],
    [UserRole.Support, PlatformPermission.ReadUsers],
    [UserRole.Risk, PlatformPermission.ManageWallets],
    [UserRole.Finance, PlatformPermission.ManageFees],
  ])('lets %s use %s', (role, permission) => {
    expect(check(role, permission)).toBe(true);
  });

  it.each([
    [UserRole.User, PlatformPermission.ReadOverview],
    [UserRole.Support, PlatformPermission.ManageUsers],
    [UserRole.Risk, PlatformPermission.ManageFees],
    [UserRole.Finance, PlatformPermission.ManageWallets],
    [UserRole.Risk, PlatformPermission.ManageRoles],
  ])('refuses %s for %s, naming the permission', (role, permission) => {
    expect(() => check(role, permission)).toThrow(
      new InsufficientRoleException(permission),
    );
  });
});
