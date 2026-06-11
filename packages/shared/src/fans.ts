import type { Platform } from "./types.ts";

export interface FanLabelInput {
  platform?: Platform;
  platformUserId: string;
  pageAlias?: string | null;
  username?: string | null;
  displayName?: string | null;
}

export interface ResolvedFanLabel {
  label: string;
  pageAlias: string | null;
  username: string | null;
  displayName: string | null;
  primarySource: "pageAlias" | "displayName" | "username" | "platformUserId" | "deleted";
  secondaryPlatformHandle: string | null;
  isDeletedFallback: boolean;
}

export const FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY = "messageSyncExcludedReason";
export const FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS =
  "partner_missing_from_aggregation_accounts" as const;
export const FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP =
  "partner_unresolvable_from_account_lookup" as const;
export const FANSLY_EXTERNAL_PRESENCE_SOURCE_FOLLOWERS_LAST_SEEN =
  "fansly_followers_last_seen" as const;
// OnlyFans lastSeen signals fed through OFAPI: the audience sweep's per-fan
// lastSeen, users.online/offline webhook events, and message-payload lastSeen.
export const OFAPI_EXTERNAL_PRESENCE_SOURCE_LAST_SEEN = "ofapi_last_seen" as const;

export type FanslyDmMessageSyncExcludedReason =
  | typeof FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS
  | typeof FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP;

export type FanslyExternalPresenceSource =
  typeof FANSLY_EXTERNAL_PRESENCE_SOURCE_FOLLOWERS_LAST_SEEN;

export type ExternalPresenceSource =
  | FanslyExternalPresenceSource
  | typeof OFAPI_EXTERNAL_PRESENCE_SOURCE_LAST_SEEN;

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

function onlyFansUserLabel(platformUserId: string) {
  return `@u${platformUserId}`;
}

export function resolveFanLabel(input: FanLabelInput): ResolvedFanLabel {
  return resolveFanLabelForScope(input, "global");
}

export function resolveFanLabelForScope(
  input: FanLabelInput,
  scope: "page" | "global",
): ResolvedFanLabel {
  const pageAlias = scope === "page"
    ? normalizeFanNamePart(input.pageAlias)
    : null;
  const displayName = normalizeFanNamePart(input.displayName);
  const username = normalizeFanNamePart(input.username);

  if (pageAlias) {
    return {
      label: pageAlias,
      pageAlias,
      username,
      displayName,
      primarySource: "pageAlias",
      secondaryPlatformHandle: username,
      isDeletedFallback: false,
    };
  }

  if (displayName) {
    return {
      label: displayName,
      pageAlias,
      username,
      displayName,
      primarySource: "displayName",
      secondaryPlatformHandle: username,
      isDeletedFallback: false,
    };
  }

  if (username) {
    return {
      label: username,
      pageAlias,
      username,
      displayName,
      primarySource: "username",
      secondaryPlatformHandle: null,
      isDeletedFallback: false,
    };
  }

  if (input.platform === "onlyfans") {
    return {
      label: onlyFansUserLabel(input.platformUserId),
      pageAlias,
      username,
      displayName,
      primarySource: "platformUserId",
      secondaryPlatformHandle: null,
      isDeletedFallback: false,
    };
  }

  return {
    label: deletedUserLabel(input.platformUserId),
    pageAlias,
    username,
    displayName,
    primarySource: "deleted",
    secondaryPlatformHandle: null,
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
