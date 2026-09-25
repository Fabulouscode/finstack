/**
 * Who money belongs to: a user (consumer products) or an organization
 * (B2B products). Tables that hold owned records carry `user_id` and
 * `organization_id` with a CHECK that exactly one is set.
 */
export type Owner =
  { kind: 'user'; id: string } | { kind: 'organization'; id: string };

/** A bare string is a user id, so existing user-centric call sites read naturally. */
export type OwnerRef = string | Owner;

export const userOwner = (id: string): Owner => ({ kind: 'user', id });
export const organizationOwner = (id: string): Owner => ({
  kind: 'organization',
  id,
});

export function toOwner(ref: OwnerRef): Owner {
  return typeof ref === 'string' ? userOwner(ref) : ref;
}

/** Filter matching records of this owner (TypeORM `where`). */
export function ownerWhere(
  ref: OwnerRef,
): { userId: string } | { organizationId: string } {
  const owner = toOwner(ref);
  return owner.kind === 'user'
    ? { userId: owner.id }
    : { organizationId: owner.id };
}

/** Owner columns for a new record: exactly one is set. */
export function ownerColumns(ref: OwnerRef): {
  userId: string | null;
  organizationId: string | null;
} {
  const owner = toOwner(ref);
  return owner.kind === 'user'
    ? { userId: owner.id, organizationId: null }
    : { userId: null, organizationId: owner.id };
}

/** The user id when the owner is a user, otherwise null. */
export function ownerUserId(ref: OwnerRef): string | null {
  const owner = toOwner(ref);
  return owner.kind === 'user' ? owner.id : null;
}
