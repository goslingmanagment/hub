// Fansly replay canonicalizer family (agent read plane, slice D).
//
// Four Fansly pull kinds have sat at parse_version 0 since Stage 8 — captured
// verbatim every sync, never turned into facts. Canonicalizing them is the
// cheapest way to move the identity/audience capture floors back toward the
// earliest journaled row: zero vendor credits, zero new capture.
//
//   followers        → follow.observed + fan.identity_observed
//   subscribers      → subscription.observed + fan.identity_observed
//   dm_conversations → conversation.observed + fan.identity_observed
//   account_me       → page.identity_observed
//
// TWO LAWS THIS FILE OBEYS.
//
// 1. THE JOURNAL IS TRIMMED. `followers` and `dm_conversations` are journaled
//    through trimFanslyFollowerPayload / trimFanslyMessagingGroupsPayload
//    (services/sync/shared.ts) — the latter runs redactFanslyMessageLike,
//    which DROPS message content entirely. These canonicalizers read the
//    TRIMMED shape and nothing else: a field the redactor removes does not
//    exist for us, and inventing one would be a fabricated fact. (`subscribers`
//    and `account_me` are journaled raw; `account_me` raw carries `email` and
//    `checkToken`, which this file NEVER copies into an event.)
//
// 2. THIS FAMILY IS NOT REGISTERED IN `CANONICALIZER_FAMILIES` ON PURPOSE.
//    Registration would put it on the minutely sweep, which no flag gates.
//    The replay runner (services/fansly-replay.ts) passes FANSLY_REPLAY_FAMILY
//    to runCanonicalization explicitly, behind `fanslyReplayMode`. A future
//    decision to make it steady-state is a one-line registration plus a
//    health-floor series — deliberately not taken in run-1.
//
// Every event is an OBSERVATION of a snapshot: `occurredAt` is the observation
// time, never the domain timestamp. Domain timestamps (followedAt, the
// subscription window, lastMessageAt) travel in `data`, so the driver's
// 2024-01-01 occurred_at clamp can never rewrite them and old follows cannot
// aim an insert at a partition that does not exist.

import { mapFanslySubscriptionStatus } from "@agency_hub_core/fansly";
import { fanslyFollowIdToDate } from "@agency_hub_core/shared";

import type { CanonicalizerFamily } from "./index.ts";
import {
  asFanslyTimestamp,
  asNumber,
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
  type CanonicalizeRunContext,
} from "./types.ts";

export const FANSLY_REPLAY_CANONICALIZER_VERSION = 1;

export const FANSLY_REPLAY_CANONICALIZED_KINDS: readonly string[] = [
  "followers",
  "subscribers",
  "dm_conversations",
  "account_me",
];

/** The event types this family mints — the projection's filter, one list. */
export const FANSLY_REPLAY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "fan.identity_observed",
  "follow.observed",
  "subscription.observed",
  "conversation.observed",
  "page.identity_observed",
]);

// ── content hashing ────────────────────────────────────────────────────────
// Same shape as the sync-pull earnings family: a snapshot re-fetch whose
// MEANINGFUL fields are unchanged must dedupe to nothing, so the dedup key
// carries a hash of exactly those fields. Volatile fields (lastSeenAt,
// unreadCount, wallet balances) are deliberately OUTSIDE every hash — folding
// them in would mint a fresh event on every sync and turn a replay of a year
// of journal into millions of rows that say nothing new.

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalJson(record[key])]),
    );
  }
  return value;
}

function stableHash(value: unknown): string {
  const canonical = JSON.stringify(canonicalJson(value));
  let hash = 0;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = (hash * 31 + canonical.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function observedAt(observation: CanonicalizableObservation): Date {
  return observation.observedAt ?? observation.receivedAt;
}

/** Fansly `autoRenew` is 0/1 on the wire; anything else is genuinely unknown. */
function asAutoRenew(value: unknown): boolean | null {
  const numeric = asNumber(value);
  if (numeric === null) {
    return typeof value === "boolean" ? value : null;
  }
  return numeric !== 0;
}

/** Snowflake-derived follow date. Malformed ids are common enough in a
 *  multi-year journal that a throw here would wedge a whole page of rows. */
function followedAtFrom(followId: string): Date | null {
  try {
    const date = fanslyFollowIdToDate(followId);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

// ── fan identity (shared by three kinds) ───────────────────────────────────

interface AccountLike {
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  createdAtExternal: number | null;
}

function readAccountLike(item: unknown): AccountLike | null {
  if (!isRecord(item)) {
    return null;
  }
  const platformUserId = asString(item.id);
  if (platformUserId === null) {
    return null;
  }
  return {
    platformUserId,
    username: asString(item.username),
    displayName: asString(item.displayName),
    createdAtExternal: asNumber(item.createdAt),
  };
}

/** aggregationData.accounts → identity events. The hash covers ONLY the
 *  durable profile fields; `lastSeenAt` (present in the trimmed follower
 *  shape) is excluded so a daily sync of an unchanged profile mints nothing. */
function identityEvents(
  observation: CanonicalizableObservation,
  accounts: unknown,
): CanonicalEventDraft[] {
  if (!Array.isArray(accounts)) {
    return [];
  }
  const events: CanonicalEventDraft[] = [];
  const seen = new Set<string>();
  for (const item of accounts) {
    const account = readAccountLike(item);
    if (account === null) {
      continue;
    }
    const identity = {
      username: account.username,
      displayName: account.displayName,
      createdAtExternal: account.createdAtExternal,
    };
    const dedupKey = `fan_identity:${account.platformUserId}:${stableHash(identity)}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    events.push({
      type: "fan.identity_observed",
      occurredAt: observedAt(observation),
      fanIdentityRef: account.platformUserId,
      data: {
        platformUserId: account.platformUserId,
        ...identity,
      },
      schemaVersion: 1,
      dedupKey,
    });
  }
  return events;
}

// ── followers ──────────────────────────────────────────────────────────────

function fanslyFollowers(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const aggregation = isRecord(observation.payload.aggregationData)
    ? observation.payload.aggregationData
    : {};
  const events: CanonicalEventDraft[] = identityEvents(observation, aggregation.accounts);

  const followers = observation.payload.followers;
  if (!Array.isArray(followers)) {
    return events;
  }
  const seen = new Set<string>();
  for (const item of followers) {
    if (!isRecord(item)) {
      continue;
    }
    const followId = asString(item.id);
    const followerId = asString(item.followerId);
    if (followId === null || followerId === null) {
      continue;
    }
    const dedupKey = `follow:${followId}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    const followedAt = followedAtFrom(followId);
    events.push({
      type: "follow.observed",
      occurredAt: observedAt(observation),
      fanIdentityRef: followerId,
      data: {
        followId,
        platformUserId: followerId,
        // The follow relation id IS the follow moment (snowflake); null only
        // when the id is unparseable, and the projection then leaves the
        // row's followed_at to the observation time rather than guessing.
        followedAt: followedAt === null ? null : followedAt.toISOString(),
      },
      schemaVersion: 1,
      dedupKey,
    });
  }
  return events;
}

// ── subscribers ────────────────────────────────────────────────────────────

function fanslySubscribers(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const subscriptions = observation.payload.subscriptions;
  if (!Array.isArray(subscriptions)) {
    return [];
  }

  const events: CanonicalEventDraft[] = [];
  const seen = new Set<string>();
  for (const item of subscriptions) {
    if (!isRecord(item)) {
      continue;
    }
    const subscriptionId = asString(item.id);
    const subscriberId = asString(item.subscriberId);
    if (subscriptionId === null || subscriberId === null) {
      continue;
    }
    const rawStatus = asNumber(item.status);
    // Money stays as the integer the platform sent: Fansly subscription
    // prices are MILLS (page_subscriptions.price_mills holds the same
    // number). Nothing here does arithmetic on them.
    const mutable = {
      rawStatus,
      priceMills: asNumber(item.price),
      renewPriceMills: asNumber(item.renewPrice),
      autoRenew: asAutoRenew(item.autoRenew),
      subscriptionTierId: asString(item.subscriptionTierId),
      endsAt: asNumber(item.endsAt),
      renewDate: asNumber(item.renewDate),
      updatedAt: asNumber(item.updatedAt),
    };
    const dedupKey = `subscription:${subscriptionId}:${stableHash(mutable)}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    const createdAt = asNumber(item.createdAt);
    events.push({
      type: "subscription.observed",
      occurredAt: observedAt(observation),
      fanIdentityRef: subscriberId,
      data: {
        subscriptionId,
        platformUserId: subscriberId,
        historyId: asString(item.historyId),
        planId: asString(item.planId),
        subscriptionTierName: asString(item.subscriptionTierName),
        canonicalStatus: rawStatus === null ? "unknown" : mapFanslySubscriptionStatus(rawStatus),
        billingCycleDays: asNumber(item.billingCycle),
        durationDays: asNumber(item.duration),
        // Subscription window in ms epoch, verbatim from the platform.
        subscribedAt: createdAt,
        ...mutable,
      },
      schemaVersion: 1,
      dedupKey,
    });
  }
  return events;
}

// ── dm_conversations ───────────────────────────────────────────────────────

/** The trimmed group shape keeps `users`; the partner is the one member that
 *  is not the page itself. Used only when `partnerAccountId` is absent — a
 *  group with several non-owner members is a real (rare) Fansly group chat and
 *  has no single partner, so it yields no partner rather than a guess. */
function partnerFromGroup(group: unknown, ownRef: string | null): string | null {
  if (!isRecord(group) || !Array.isArray(group.users)) {
    return null;
  }
  const candidates = new Set<string>();
  for (const user of group.users) {
    if (!isRecord(user)) {
      continue;
    }
    const userId = asString(user.userId);
    if (userId !== null && userId !== ownRef) {
      candidates.add(userId);
    }
  }
  if (candidates.size !== 1) {
    return null;
  }
  return [...candidates][0] ?? null;
}

function fanslyDmConversations(
  observation: CanonicalizableObservation,
  context: CanonicalizeRunContext | undefined,
): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const aggregation = isRecord(observation.payload.aggregationData)
    ? observation.payload.aggregationData
    : {};
  const events: CanonicalEventDraft[] = identityEvents(observation, aggregation.accounts);

  const conversations = observation.payload.data;
  if (!Array.isArray(conversations)) {
    return events;
  }

  const groupsById = new Map<string, unknown>();
  if (Array.isArray(aggregation.groups)) {
    for (const group of aggregation.groups) {
      const groupId = isRecord(group) ? asString(group.id) : null;
      if (groupId !== null) {
        groupsById.set(groupId, group);
      }
    }
  }

  const contextOwnRef = observation.accountId == null
    ? null
    : context?.nativeAccountRefByAccountId.get(observation.accountId) ?? null;

  const seen = new Set<string>();
  for (const item of conversations) {
    if (!isRecord(item)) {
      continue;
    }
    const groupId = asString(item.groupId);
    if (groupId === null) {
      continue;
    }
    // The trimmed conversation row carries the page's own ref as account_id;
    // it is a better owner witness for a historical row than today's page
    // mapping, so it wins and the run context is the fallback.
    const ownRef = asString(item.account_id) ?? contextOwnRef;
    const group = groupsById.get(groupId);
    const partnerPlatformUserId = asString(item.partnerAccountId)
      ?? partnerFromGroup(group, ownRef);
    const partnerUsername = asString(item.partnerUsername);
    const lastMessageId = asString(item.lastMessageId);
    const identity = {
      partnerPlatformUserId,
      partnerUsername,
      lastMessageId,
      subscriptionTierId: asString(item.subscriptionTierId),
    };
    const dedupKey = `conversation:${groupId}:${stableHash(identity)}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);

    // redactFanslyMessageLike strips content but keeps the head's id, sender
    // and createdAt — the only three we read, and each may legitimately be
    // absent (a group with no messages trims to `lastMessage: null`).
    const lastMessage = isRecord(group) && isRecord(group.lastMessage) ? group.lastMessage : null;
    const lastMessageCreatedAt = lastMessage === null ? null : asNumber(lastMessage.createdAt);

    events.push({
      type: "conversation.observed",
      occurredAt: observedAt(observation),
      fanIdentityRef: partnerPlatformUserId,
      conversationRef: groupId,
      messageRef: lastMessageId,
      data: {
        groupId,
        ...identity,
        conversationFlags: asNumber(item.flags),
        lastMessageAt: lastMessageCreatedAt === null
          ? null
          : asFanslyTimestamp(lastMessageCreatedAt, observedAt(observation)).toISOString(),
        lastMessageSenderId: lastMessage === null ? null : asString(lastMessage.senderId),
      },
      schemaVersion: 1,
      dedupKey,
    });
  }
  return events;
}

// ── account_me ─────────────────────────────────────────────────────────────

function fanslyAccountMe(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  if (!isRecord(observation.payload) || !isRecord(observation.payload.account)) {
    return [];
  }
  const account = observation.payload.account;
  const platformAccountRef = asString(account.id);
  if (platformAccountRef === null) {
    return [];
  }
  // Field-by-field by design: the raw account_me payload also carries `email`
  // and `checkToken`. A spread would journal a live session secret into the
  // queryable ledger.
  const identity = {
    username: asString(account.username),
    displayName: asString(account.displayName),
    followCount: asNumber(account.followCount),
    subscriberCount: asNumber(account.subscriberCount),
    createdAtExternal: asNumber(account.createdAt),
  };
  return [{
    type: "page.identity_observed",
    occurredAt: observedAt(observation),
    fanIdentityRef: null,
    data: {
      platformAccountRef,
      ...identity,
    },
    schemaVersion: 1,
    dedupKey: `page_identity:${platformAccountRef}:${stableHash(identity)}`,
  }];
}

// ── dispatch ───────────────────────────────────────────────────────────────

/** Fansly-only by construction. `dm_conversations` is the one kind OFAPI also
 *  journals under the same name with a completely different shape, so the
 *  platform is dispatched on rather than sniffed — via `switch`, which is the
 *  form the Stage 18 platform-branch ratchet asks for. */
export function canonicalizeFanslyReplayObservation(
  observation: CanonicalizableObservation,
  context?: CanonicalizeRunContext,
): CanonicalEventDraft[] {
  switch (observation.platform) {
    case "fansly":
      break;
    default:
      return [];
  }
  switch (observation.kind) {
    case "followers":
      return fanslyFollowers(observation);
    case "subscribers":
      return fanslySubscribers(observation);
    case "dm_conversations":
      return fanslyDmConversations(observation, context);
    case "account_me":
      return fanslyAccountMe(observation);
    default:
      return [];
  }
}

/** Deliberately absent from CANONICALIZER_FAMILIES — see the file header. */
export const FANSLY_REPLAY_FAMILY: CanonicalizerFamily = {
  source: "pull",
  kinds: FANSLY_REPLAY_CANONICALIZED_KINDS,
  version: FANSLY_REPLAY_CANONICALIZER_VERSION,
  canonicalize: canonicalizeFanslyReplayObservation,
};
