import { SetMetadata } from '@nestjs/common';
import { PlatformPermission } from '../platform-permissions';

export const PLATFORM_PERMISSION_KEY = 'finstack:platform-permission';

/**
 * Restricts a route to staff whose platform role grants `permission`.
 * On a class it applies to every route; a method-level one overrides it.
 */
export const RequirePermission = (
  permission: PlatformPermission,
): MethodDecorator & ClassDecorator =>
  SetMetadata(PLATFORM_PERMISSION_KEY, permission);
