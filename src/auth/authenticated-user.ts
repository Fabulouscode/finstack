import { Request } from 'express';
import { UserRole } from '../users/user.entity';

/** Identity derived from a verified access token. */
export interface AuthenticatedUser {
  id: string;
  role: UserRole;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}
