import { Request } from 'express';
import type { ApiKeyPrincipal } from '../api-keys/api-key-principal';
import { UserRole } from '../users/user.entity';

/** Identity derived from a verified access token. */
export interface AuthenticatedUser {
  id: string;
  role: UserRole;
}

export interface AuthenticatedRequest extends Request {
  /** Set when authenticated with a user access token. */
  user?: AuthenticatedUser;
  /** Set when authenticated with an API key (only on @AllowApiKey routes). */
  apiKey?: ApiKeyPrincipal;
}
