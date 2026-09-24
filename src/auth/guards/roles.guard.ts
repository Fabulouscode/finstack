import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../users/user.entity';
import { InsufficientRoleException } from '../auth.errors';
import { AuthenticatedRequest } from '../authenticated-user';
import { ROLES_KEY } from '../decorators/roles.decorator';

/** Enforces @Roles(). Runs after JwtAuthGuard; routes without @Roles() pass. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!roles || roles.length === 0) {
      return true;
    }

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user || !roles.includes(user.role)) {
      throw new InsufficientRoleException();
    }
    return true;
  }
}
