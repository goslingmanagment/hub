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

/** UTC day of an observation — the grain the follower rollups are keyed by. */
function businessDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// ── vendor timestamps ──────────────────────────────────────────────────────
// Fansly mixes epoch SECONDS and epoch MILLISECONDS across the same payload
// family; misreading one as the other is what put events in 1970 and cost the
// repo migration 0077. Live payloads also carry a literal `0` for "never".
//
// These values become DOMAIN timestamps, and the projection folds them with
// `least()` — monotonically EARLIER — so a floor written from a 1970 value can
// never be repaired by a later, correct run. Therefore: interpret with the
// house heuristic, then REFUSE (null) anything that cannot be a real moment on
// this platform. Null means "unknown" and the projection writes nothing for
// it; a guessed default would be a fabricated capture floor.

/** Fansly's own follow-relation epoch (2019-06-25). The platform did not
 *  exist before it, so nothing earlier is a real Fansly moment — this is the
 *  line that turns a seconds/ms mix-up into a refusal instead of 1970. */
const FANSLY_PLATFORM_EPOCH_MS = 1_561_494_359_900;
/** Overflowed or fat-fingered values (an ms value wrongly scaled as seconds
 *  lands far up here) are refused rather than believed. */
const IMPLAUSIBLE_FUTURE_MS = Date.UTC(2100, 0, 1);

export function asDomainInstant(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const ms = value >= 1_000_000_000_000 ? value : value * 1000;
  if (!Number.isFinite(ms) || ms < FANSLY_PLATFORM_EPOCH_MS || ms >= IMPLAUSIBLE_FUTURE_MS) {
    return null;
  }
  const parsed = new Date(ms);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Every instant leaves the canonicalizer as an ISO string or null, so no
 * downstream reader ever repeats the seconds-vs-milliseconds decision.
 *
 * A refusal is COUNTED. Refusing is right for one bad value, but a SYSTEMATIC
 * decode failure would otherwise produce a green report with quietly fewer
 * rows; the counter is what turns "dropped on purpose" into something an
 * operator can see. An absent field is not a refusal — only a present value
 * we declined to believe.
 */
function asDomainInstantIso(
  value: unknown,
  context: CanonicalizeRunContext | undefined,
  code: string,
): string | null {
  const instant = asDomainInstant(value);
  if (instant === null && value !== undefined && value !== null) {
    context?.diagnostics?.record(`timestamp_refused:${code}`);
  }
  return instant?.toISOString() ?? null;
}

/** Fansly `autoRenew` is 0/1 on the wire; anything else is genuinely unknown. */
function asAutoRenew(value: unknown): boolean | null {
  const numeric = asNumber(value);
  if (numeric === null) {
    return typeof value === "boolean" ? value : null;
  }
  return numeric !== 0;
}

/** Snowflake-derived follow date, held to the same plausibility line: an id
 *  that does not decode to a real Fansly moment yields null, and the follow
 *  then contributes NO row rather than one dated by guesswork. Malformed ids
 *  are common enough in a multi-year journal that a throw here would wedge a
 *  whole page of rows. */
function followedAtFrom(
  followId: string,
  context: CanonicalizeRunContext | undefined,
): Date | null {
  const refuse = () => {
    context?.diagnostics?.record("timestamp_refused:followers.followId");
    return null;
  };
  try {
    const decoded = fanslyFollowIdToDate(followId);
    if (Number.isNaN(decoded.getTime())) {
      return refuse();
    }
    const ms = decoded.getTime();
    // The decode is `epoch + (id >> 22)`, so it can never land BEFORE the
    // epoch — landing exactly ON it means the id carried no timestamp at all
    // (a garbage id like "1"). Dating a follow at the platform's zero instant
    // would be a fabricated floor, so that case is refused too.
    return ms <= FANSLY_PLATFORM_EPOCH_MS || ms >= IMPLAUSIBLE_FUTURE_MS ? refuse() : decoded;
  } catch {
    return refuse();
  }
}

// ── fan identity (shared by three kinds) ───────────────────────────────────

interface AccountLike {
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  /** Already interpreted and plausibility-checked; null = unknown. */
  createdAtExternal: string | null;
}

function readAccountLike(
  item: unknown,
  context: CanonicalizeRunContext | undefined,
): AccountLike | null {
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
    createdAtExternal: asDomainInstantIso(item.createdAt, context, "accounts.createdAt"),
  };
}

/** aggregationData.accounts → identity events. The hash covers ONLY the
 *  durable profile fields; `lastSeenAt` (present in the trimmed follower
 *  shape) is excluded so a daily sync of an unchanged profile mints nothing. */
function identityEvents(
  observation: CanonicalizableObservation,
  accounts: unknown,
  context: CanonicalizeRunContext | undefined,
): CanonicalEventDraft[] {
  if (!Array.isArray(accounts)) {
    return [];
  }
  const events: CanonicalEventDraft[] = [];
  const seen = new Set<string>();
  for (const item of accounts) {
    const account = readAccountLike(item, context);
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

function fanslyFollowers(
  observation: CanonicalizableObservation,
  context: CanonicalizeRunContext | undefined,
): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const aggregation = isRecord(observation.payload.aggregationData)
    ? observation.payload.aggregationData
    : {};
  const events: CanonicalEventDraft[] = identityEvents(observation, aggregation.accounts, context);

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
    const followedAt = followedAtFrom(followId, context);
    events.push({
      type: "follow.observed",
      occurredAt: observedAt(observation),
      fanIdentityRef: followerId,
      data: {
        followId,
        platformUserId: followerId,
        // The follow relation id IS the follow moment (snowflake). Null when
        // the id does not decode to a real Fansly moment — and the projection
        // then creates NO page_follows row at all, rather than dating one by
        // guesswork.
        followedAt: followedAt === null ? null : followedAt.toISOString(),
      },
      schemaVersion: 1,
      dedupKey,
    });
  }
  return events;
}

// ── subscribers ────────────────────────────────────────────────────────────

function fanslySubscribers(
  observation: CanonicalizableObservation,
  context: CanonicalizeRunContext | undefined,
): CanonicalEventDraft[] {
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
    const data = {
      subscriptionId,
      platformUserId: subscriberId,
      historyId: asString(item.historyId),
      planId: asString(item.planId),
      subscriptionTierName: asString(item.subscriptionTierName),
      canonicalStatus: rawStatus === null ? "unknown" : mapFanslySubscriptionStatus(rawStatus),
      billingCycleDays: asNumber(item.billingCycle),
      durationDays: asNumber(item.duration),
      subscribedAt: asDomainInstantIso(item.createdAt, context, "subscriptions.createdAt"),
      rawStatus,
      priceMills: asNumber(item.price),
      renewPriceMills: asNumber(item.renewPrice),
      autoRenew: asAutoRenew(item.autoRenew),
      subscriptionTierId: asString(item.subscriptionTierId),
      // Interpreted, not raw: the window fields legitimately sit in the
      // future, so only the epoch floor and the overflow ceiling apply.
      endsAt: asDomainInstantIso(item.endsAt, context, "subscriptions.endsAt"),
      renewDate: asDomainInstantIso(item.renewDate, context, "subscriptions.renewDate"),
      updatedAt: asDomainInstantIso(item.updatedAt, context, "subscriptions.updatedAt"),
    };
    // Hash the WHOLE payload, not a hand-picked subset. An enumerated subset
    // silently suppresses a correction to any field outside it: a later
    // snapshot that fills or fixes `createdAt` while the rest is unchanged
    // would collide on `domain_event_keys` and never be appended. Hashing
    // everything makes that class of bug structurally impossible. The
    // subscription id stays in the key prefix so the rows remain groupable.
    const dedupKey = `subscription:${subscriptionId}:${stableHash(data)}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    events.push({
      type: "subscription.observed",
      occurredAt: observedAt(observation),
      fanIdentityRef: subscriberId,
      data,
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
  const events: CanonicalEventDraft[] = identityEvents(observation, aggregation.accounts, context);

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
        lastMessageAt: lastMessage === null
          ? null
          : asDomainInstantIso(lastMessage.createdAt, context, "groups.lastMessage.createdAt"),
        lastMessageSenderId: lastMessage === null ? null : asString(lastMessage.senderId),
      },
      schemaVersion: 1,
      dedupKey,
    });
  }
  return events;
}

// ── account_me ─────────────────────────────────────────────────────────────

function fanslyAccountMe(
  observation: CanonicalizableObservation,
  context: CanonicalizeRunContext | undefined,
): CanonicalEventDraft[] {
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
  const at = observedAt(observation);
  const identity = {
    username: asString(account.username),
    displayName: asString(account.displayName),
    followCount: asNumber(account.followCount),
    subscriberCount: asNumber(account.subscriberCount),
    createdAtExternal: asDomainInstantIso(account.createdAt, context, "account.createdAt"),
  };
  const day = businessDate(at);
  return [{
    type: "page.identity_observed",
    occurredAt: at,
    fanIdentityRef: null,
    data: {
      platformAccountRef,
      businessDate: day,
      ...identity,
    },
    schemaVersion: 1,
    // The UTC day is part of the key ON PURPOSE. Content alone would collapse
    // two identical daily snapshots into one event, and the later day would
    // silently lose its follower-total witness even though the journal proves
    // the observation happened — the rollups are keyed by day, so the witness
    // must be too.
    dedupKey: `page_identity:${platformAccountRef}:${day}:${stableHash(identity)}`,
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
      return fanslyFollowers(observation, context);
    case "subscribers":
      return fanslySubscribers(observation, context);
    case "dm_conversations":
      return fanslyDmConversations(observation, context);
    case "account_me":
      return fanslyAccountMe(observation, context);
    default:
      return [];
  }
}

/**
 * Shape gate. Answers ONE question: does this payload match a shape we know?
 *
 * "Zero events" is ambiguous by itself — an empty followers page and a payload
 * whose whole structure drifted both produce it, yet only the first may be
 * stamped consumed. Stamping the second would remove it from every future
 * replay as effectively as deleting it, which is precisely what the
 * parse_version contract exists to prevent (and the same bug shape as the
 * OnlyFans stamping fixed in review round 1, this time for Fansly).
 *
 * So: the CONTAINER must be present and of the right type. Its contents may be
 * empty — that is a real, stampable observation of "nothing there".
 */
export function canParseFanslyReplayObservation(
  observation: CanonicalizableObservation,
): boolean {
  if (observation.platform !== "fansly") {
    // Not ours to judge; the account scoping keeps these out of the scan and
    // the dispatch returns no events regardless.
    return true;
  }
  if (!isRecord(observation.payload)) {
    return false;
  }
  const payload = observation.payload;
  switch (observation.kind) {
    case "followers": {
      // The trimmer always emits both keys; a payload missing them entirely is
      // a shape we do not recognise.
      const aggregation = isRecord(payload.aggregationData) ? payload.aggregationData : null;
      return Array.isArray(payload.followers)
        || (aggregation !== null && Array.isArray(aggregation.accounts));
    }
    case "subscribers":
      return Array.isArray(payload.subscriptions);
    case "dm_conversations":
      return Array.isArray(payload.data);
    case "account_me":
      return isRecord(payload.account) && asString(payload.account.id) !== null;
    default:
      return true;
  }
}

/** Deliberately absent from CANONICALIZER_FAMILIES — see the file header. */
export const FANSLY_REPLAY_FAMILY: CanonicalizerFamily = {
  source: "pull",
  kinds: FANSLY_REPLAY_CANONICALIZED_KINDS,
  version: FANSLY_REPLAY_CANONICALIZER_VERSION,
  canonicalize: canonicalizeFanslyReplayObservation,
  canParse: canParseFanslyReplayObservation,
  // Backfill of year-old facts under fresh account_seq values: delivering it
  // would hand a reconnecting client a year of "news". Every type above is
  // registered projection-only, and the driver appends the covering
  // checkpoint.
  projectionOnly: true,
};
