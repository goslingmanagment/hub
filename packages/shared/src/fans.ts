export interface FanLabelInput {
  platformUserId: string;
  username?: string | null;
  displayName?: string | null;
}

export interface ResolvedFanLabel {
  label: string;
  username: string | null;
  displayName: string | null;
  isDeletedFallback: boolean;
}

export const FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY = "messageSyncExcludedReason";
export const FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS =
  "partner_missing_from_aggregation_accounts" as const;
export const FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP =
  "partner_unresolvable_from_account_lookup" as const;

export type FanslyDmMessageSyncExcludedReason =
  | typeof FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS
  | typeof FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP;

function normalizeFanNamePart(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function deletedUserLabel(platformUserId: string) {
  const shortId = platformUserId.length > 8
    ? platformUserId.slice(-8)
    : platformUserId;
  return `Deleted user · ${shortId}`;
}

export function resolveFanLabel(input: FanLabelInput): ResolvedFanLabel {
  const displayName = normalizeFanNamePart(input.displayName);
  const username = normalizeFanNamePart(input.username);

  if (displayName) {
    return {
      label: displayName,
      username,
      displayName,
      isDeletedFallback: false,
    };
  }

  if (username) {
    return {
      label: username,
      username,
      displayName,
      isDeletedFallback: false,
    };
  }

  return {
    label: deletedUserLabel(input.platformUserId),
    username,
    displayName,
    isDeletedFallback: true,
  };
}

export function getFanslyDmMessageSyncExcludedReason(
  metadata: Record<string, unknown> | null | undefined,
): FanslyDmMessageSyncExcludedReason | null {
  if (!metadata) {
    return null;
  }

  const reason = metadata[FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY];
  return reason === FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS ||
      reason === FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP
    ? reason
    : null;
}

export function isFanslyDmMessageSyncExcluded(
  metadata: Record<string, unknown> | null | undefined,
) {
  return getFanslyDmMessageSyncExcludedReason(metadata) !== null;
}

export function buildFanslyDmConversationMetadata(input: {
  unresolvedIdentity?: boolean;
  messageSyncExcludedReason?: FanslyDmMessageSyncExcludedReason | null;
}) {
  const metadata: Record<string, unknown> = {};

  if (input.unresolvedIdentity) {
    metadata.unresolvedIdentity = true;
  }

  if (input.messageSyncExcludedReason) {
    metadata[FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY] = input.messageSyncExcludedReason;
  }

  return metadata;
}
