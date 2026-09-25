import { SetMetadata } from '@nestjs/common';
import { OrgPermission } from '../organizations/organization-permissions';

export const API_KEY_HEADER_NAME = 'x-api-key';

/** Identity established from a valid API key. */
export interface ApiKeyPrincipal {
  id: string;
  organizationId: string;
  scopes: readonly string[];
}

export const ALLOW_API_KEY = 'finstack:allow-api-key';

/**
 * Accepts `X-API-Key` on this route (in addition to user access tokens).
 * Routes without it reject API keys: keys work only where explicitly allowed.
 */
export const AllowApiKey = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_API_KEY, true);

/**
 * Permissions an API key may carry. Keys act on data; they can't manage
 * members, other keys or the organization itself.
 */
export const API_KEY_SCOPES = [
  OrgPermission.ReadOrganization,
  OrgPermission.ReadWallets,
  OrgPermission.ManageWallets,
  OrgPermission.CreatePayments,
  OrgPermission.ReadTransactions,
  OrgPermission.CreatePayouts,
] as const;
