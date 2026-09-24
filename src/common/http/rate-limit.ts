import { ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const DEFAULT_THROTTLER = 'default';
export const AUTH_THROTTLER = 'auth';

const AUTH_RATE_LIMITED = 'finstack:auth-rate-limited';
const reflector = new Reflector();

/**
 * Applies the stricter `auth` rate limit (AUTH_RATE_LIMIT_MAX per window) on
 * top of the default one. Use on endpoints that accept credentials.
 */
export const AuthRateLimit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTH_RATE_LIMITED, true);

export function isAuthRateLimited(context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(AUTH_RATE_LIMITED, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}
