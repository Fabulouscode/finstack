/** Every audited action, so the vocabulary stays consistent and discoverable. */
export const AuditAction = {
  OrganizationCreated: 'organization.created',
  OrganizationRenamed: 'organization.renamed',
  OwnershipTransferred: 'organization.ownership_transferred',
  MemberAdded: 'member.added',
  MemberRoleChanged: 'member.role_changed',
  MemberRemoved: 'member.removed',
  ApiKeyCreated: 'api_key.created',
  ApiKeyRevoked: 'api_key.revoked',
  WalletCreated: 'wallet.created',
  WalletPrimaryChanged: 'wallet.primary_changed',
  PayoutDestinationAdded: 'payout_destination.added',
  PayoutDestinationRemoved: 'payout_destination.removed',
  PayoutRequested: 'payout.requested',
  PaymentReleasedEarly: 'payment.released_early',
  RefundRequested: 'refund.requested',
  RefundRetried: 'refund.retried',
  FxRateSet: 'fx.rate_set',
  WebhookReplayed: 'webhook.replayed',
  RefreshTokenReuseDetected: 'auth.refresh_token_reuse_detected',
} as const;

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];
