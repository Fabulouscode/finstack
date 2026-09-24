import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'finstack:is-public';

/** Opts a route or controller out of the global access-token requirement. */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
