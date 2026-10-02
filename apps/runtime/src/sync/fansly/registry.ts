import type { SyncStream } from "@agency_hub_core/db";
import type { FanslyObservationKind, FanslySendSource, FanslyWireId } from "@agency_hub_core/fansly";

import { FOLLOWERS_RECONCILE_MIN_INTERVAL_MS } from "../../services/sync/followers-reconcile-floor.ts";
import type { Metrics } from "../engine/ports.ts";
import {
  createEngineRegistry,
  type EngineRegistry,
  type EngineResourceSpec,
  type ResourceModule,
} from "../engine/resource.ts";

// ALL Fansly resources of the Sync Engine (plan §5, design §4.4): one entry
// per resource variant — trigger, period, class, coalescing, SLO, proof,
// walk, the wire operations it sends and the legacy streams and senders it
// replaces (pinned by tests/sync-registry-coverage.test.ts).
//
// "How fresh a resource is" is one line here (a period, a coalescing window);
// a change to an owner-protected frequency (decision №6) needs the owner.
// An entry whose code has not landed yet has no `module`: its work waits on
// `dependency` and counts `sync_not_implemented` (S2-07b … S3-04 fill them).

/** The resource file a key belongs to (`<file>.<variant>`). */
export type ResourceFile =
  | "account" | "ws" | "dm-conversations" | "dm-messages" | "dm-live" | "transactions" | "top-spenders"
  | "fan-earnings" | "purchases" | "payouts" | "subscribers" | "followers" | "fan-profiles" | "notifications"
  | "posts" | "post-replies" | "catalog" | "media-stats" | "stats" | "media-download" | "repair" | "probe";

/** What creates or bumps the work (design §4.1). */
export type Trigger =
  | "poll" | "request" | "owner" | "api" | "ws_lifecycle" | "ws_gap" | "dependency" | "projection_queue"
  | "legacy_import" | "new_page" | `ws:${string}` | `apply:${string}`;

/** What a finished step proves (design §4.1, §8). */
export type ProofKind =
  | "none" | "snapshot" | "chain_empty_page" | "head_known_item" | "offset_stable" | "offset_stable_total"
  | "reconcile_membership" | "empty_page" | "window_honoured" | "vault_walk" | "receipt";

/** How the work walks its source (design §4.1). */
export type WalkKind =
  | "single" | "snapshot-sequence" | "cursor-walk" | "offset-walk" | "incremental-head" | "subject-queue"
  | "windows" | "composite" | "none";

/** A legacy stream or sender (maps/senders.md §3) an entry takes over. */
export type LegacyRef = { stream: SyncStream } | { sender: FanslySendSource };

export interface TierSpec { maxAgeDays: number | null; everyMs: number }

export interface ResourceSpec extends EngineResourceSpec {
  file: ResourceFile;
  /** What one work row is about. */
  subject: "page" | "thread" | "target" | "fan" | "post" | "media";
  triggers: readonly Trigger[];
  /** Goals re-evaluated on a cadence (a walk's due subjects, a daily
   *  incremental / weekly full sweep); polls use `period`. */
  cadence?: { everyMs: number; fullEveryMs?: number };
  /** Subject-queue walks by age tier (owner decision №6 for media stats). */
  tiers?: readonly TierSpec[];
  /** A new walk starts at most this long after the previous one started
   *  (followers reconcile: the owner's daily floor). */
  minIntervalMs?: number;
  proof: ProofKind;
  walk: WalkKind;
  /** Every wire route its steps send; empty for socket, CDN and no-HTTP work. */
  operations: readonly FanslyWireId[];
  /** The observation kinds this entry replays for the shadow report (one
   *  owner per kind, design §3.12 B5). */
  replayKinds?: readonly FanslyObservationKind[];
  /** `subject_refresh_state` plane of a subject-queue walk (design §4.3). */
  queuePlane?: string;
  legacy: readonly LegacyRef[];
}

/** A legacy stream or sender no entry takes over, and why (design §4.5). */
export interface LegacyDisposition {
  ref: LegacyRef;
  disposition: "retired" | "stays_legacy" | "by_streams";
  reason: string;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const stream = (name: SyncStream): LegacyRef => ({ stream: name });
const sender = (name: FanslySendSource): LegacyRef => ({ sender: name });

const accountModule = (variant: "poll" | "verify" | "identity") => async (): Promise<ResourceModule> =>
  (await import("./resources/account.ts")).accountModule(variant);
const subscribersModule = (variant: "poll" | "history") => async (): Promise<ResourceModule> =>
  (await import("./resources/subscribers.ts")).subscribersModule(variant);
const followersModule = (variant: "head" | "reconcile") => async (): Promise<ResourceModule> =>
  (await import("./resources/followers.ts")).followersModule(variant);
const fanProfilesModule = (variant: "lookup" | "probe" | "alias-backfill") => async (): Promise<ResourceModule> => {
  const resources = await import("./resources/fan-profiles.ts");
  switch (variant) {
    case "lookup":
      return resources.fanProfilesLookupModule;
    case "probe":
      return resources.fanProfilesProbeModule;
    case "alias-backfill":
      return resources.fanProfilesAliasBackfillModule;
  }
};

const notificationsModule = (variant: "forward" | "backfill") => async (): Promise<ResourceModule> =>
  (await import("./resources/notifications.ts")).notificationsModule(variant);
const postsModule = (variant: "refresh" | "backfill" | "engagement") => async (): Promise<ResourceModule> =>
  (await import("./resources/posts.ts")).postsModule(variant);
const postRepliesModule = (variant: "walk" | "authors") => async (): Promise<ResourceModule> =>
  (await import("./resources/post-replies.ts")).postRepliesModule(variant);

const STATS_DAILY_OPERATIONS: readonly FanslyWireId[] = [
  "account.stats", "earnings.stats_window", "earnings.monthly", "trackinglinks", "discovery.suggestions",
  "broadcast.stats", "broadcast.stats_deleted", "broadcast.scheduled", "polls", "recapstats",
];

export const FANSLY_RESOURCE_SPECS: readonly ResourceSpec[] = [
  // ── account (S2-07a) ──────────────────────────────────────────────────────
  {
    key: "account.poll", file: "account", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll", "dependency"],
    // Must stay ≤ 2 h: the subscribers stated-empty rule and the followers
    // head read its counters.
    period: { everyMs: HOUR }, slo: { staleAfterMs: 3 * HOUR },
    proof: "snapshot", walk: "single", http: true, evidence: false, fence: "none",
    operations: ["account.me"], replayKinds: ["account_me"],
    legacy: [stream("light")],
    module: accountModule("poll"),
  },
  {
    key: "account.verify", file: "account", subject: "page", kind: "trigger", class: "urgent",
    triggers: ["api", "owner"], slo: { resultMs: 30 * SECOND },
    proof: "snapshot", walk: "single", http: true, evidence: false, fence: "none",
    operations: ["account.me"],
    legacy: [sender("account_me_api"), sender("account_me_cli")],
    module: accountModule("verify"),
  },
  {
    key: "account.identity", file: "account", subject: "page", kind: "trigger", class: "urgent",
    triggers: ["api", "owner"], slo: { resultMs: 30 * SECOND },
    proof: "snapshot", walk: "single", http: true, liveOnly: true, evidence: false, fence: "none",
    operations: ["account.me"],
    legacy: [sender("account_me_api"), sender("account_me_cli"), sender("binding_preflight")],
    module: accountModule("identity"),
  },

  // ── ws (step 3) ───────────────────────────────────────────────────────────
  {
    key: "ws.connect", file: "ws", subject: "page", kind: "trigger", class: "urgent",
    triggers: ["ws_lifecycle"], slo: {},
    proof: "none", walk: "single", http: true, liveOnly: true, evidence: false, fence: "none",
    operations: [],
    legacy: [sender("ws_connect")],
  },

  // ── dm-live (no HTTP) ─────────────────────────────────────────────────────
  {
    key: "dm-live.deletions", file: "dm-live", subject: "thread", kind: "trigger", class: "urgent",
    triggers: ["ws:message_deleted"],
    coalesce: { quietMs: 0, maxMs: SECOND, extendOnSignal: false }, slo: { resultMs: 5 * SECOND },
    proof: "none", walk: "none", http: false, evidence: false, fence: "dm_archive",
    operations: [],
    legacy: [],
  },

  // ── dm-conversations (S2-08a) ─────────────────────────────────────────────
  {
    key: "dm-conversations.head", file: "dm-conversations", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: 30 * MINUTE }, slo: { staleAfterMs: 90 * MINUTE },
    proof: "head_known_item", walk: "offset-walk", http: true, evidence: false, fence: "dm_archive",
    operations: ["messaging.groups"], replayKinds: ["dm_conversations"],
    legacy: [stream("dm_conversations")],
  },
  {
    key: "dm-conversations.full", file: "dm-conversations", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: DAY }, slo: { staleAfterMs: 3 * DAY },
    proof: "offset_stable", walk: "offset-walk", http: true, evidence: false, fence: "dm_archive",
    operations: ["messaging.groups"],
    legacy: [stream("dm_conversations")],
  },
  {
    key: "dm-conversations.find", file: "dm-conversations", subject: "thread", kind: "trigger", class: "urgent",
    triggers: ["ws:group_created", "ws:message_unknown_chat"],
    coalesce: { quietMs: 0, maxMs: 0, extendOnSignal: false }, slo: { resultMs: 12 * SECOND },
    proof: "snapshot", walk: "single", http: true, evidence: false, fence: "dm_archive",
    operations: ["messaging.groups", "group.detail"], replayKinds: ["group_detail"],
    legacy: [stream("dm_conversations"), sender("ws_hint")],
  },
  {
    key: "dm-conversations.detail", file: "dm-conversations", subject: "thread", kind: "trigger", class: "planned",
    triggers: ["apply:dm-conversations.*"], slo: {},
    proof: "snapshot", walk: "single", http: true, evidence: false, fence: "dm_archive",
    operations: ["group.detail"],
    legacy: [stream("dm_conversations")],
  },
  {
    // Polls the list head every 30 s only while the socket is down (> 2 min):
    // the socket's lifecycle creates it and its module re-arms it, so it is
    // not a standing poll row of the page.
    key: "dm-conversations.ws-down", file: "dm-conversations", subject: "page", kind: "trigger", class: "urgent",
    triggers: ["ws_lifecycle"], cadence: { everyMs: 30 * SECOND }, slo: { resultMs: 45 * SECOND },
    proof: "head_known_item", walk: "single", http: true, liveOnly: true, evidence: false, fence: "dm_archive",
    operations: ["messaging.groups"],
    legacy: [stream("dm_conversations")],
  },

  // ── dm-messages (S2-08b) ──────────────────────────────────────────────────
  {
    key: "dm-messages.head", file: "dm-messages", subject: "thread", kind: "trigger", class: "urgent",
    triggers: ["ws:message_created", "ws:message_invalid_known_chat", "apply:dm-conversations.ws-down", "ws_gap"],
    coalesce: { quietMs: 5 * SECOND, maxMs: 20 * SECOND, extendOnSignal: true, fast: { quietMs: 2 * SECOND, maxMs: 6 * SECOND } },
    slo: { resultMs: 30 * SECOND },
    proof: "chain_empty_page", walk: "incremental-head", http: true, evidence: true, fence: "dm_archive",
    operations: ["messages.page"], replayKinds: ["dm_messages"],
    legacy: [stream("dm_messages"), sender("ws_hint"), sender("ai_accelerator"), sender("ai_fast_lane")],
  },
  {
    key: "dm-messages.catchup", file: "dm-messages", subject: "thread", kind: "trigger", class: "planned",
    triggers: ["apply:dm-conversations.head", "apply:dm-conversations.full", "legacy_import"],
    coalesce: { quietMs: MINUTE, maxMs: 10 * MINUTE, extendOnSignal: true }, slo: { staleAfterMs: 6 * HOUR },
    proof: "chain_empty_page", walk: "incremental-head", http: true, evidence: true, fence: "dm_archive",
    operations: ["messages.page"],
    legacy: [stream("dm_messages"), stream("dm_conversations")],
  },
  {
    // I12: no history walk without a request (owner decision №2).
    key: "dm-messages.history", file: "dm-messages", subject: "thread", kind: "goal", class: "requests",
    triggers: ["request"], slo: {},
    proof: "chain_empty_page", walk: "cursor-walk", http: true, evidence: true, fence: "dm_archive",
    operations: ["messages.page"],
    legacy: [stream("dm_messages"), sender("targeted_backfill")],
  },

  // ── transactions (S2-07b) ─────────────────────────────────────────────────
  {
    key: "transactions.head", file: "transactions", subject: "page", kind: "trigger", class: "urgent",
    triggers: ["ws:transaction", "ws:order", "ws:wallet", "ws:subscription"],
    coalesce: { quietMs: 2 * SECOND, maxMs: 2 * SECOND, extendOnSignal: false }, slo: { resultMs: 15 * SECOND },
    proof: "head_known_item", walk: "offset-walk", http: true, evidence: false, fence: "dm_archive",
    operations: ["transactions.page"], replayKinds: ["earnings_transactions"],
    legacy: [stream("transactions")],
  },
  {
    // Owner decision №5: the insurance poll every 5 minutes.
    key: "transactions.insurance", file: "transactions", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: 5 * MINUTE }, slo: { staleAfterMs: 15 * MINUTE },
    proof: "head_known_item", walk: "offset-walk", http: true, evidence: false, fence: "dm_archive",
    operations: ["transactions.page"],
    legacy: [stream("transactions")],
  },
  {
    key: "transactions.rescan", file: "transactions", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll", "ws:transaction"], period: { everyMs: HOUR }, slo: { staleAfterMs: 3 * HOUR },
    proof: "offset_stable_total", walk: "offset-walk", http: true, evidence: false, fence: "dm_archive",
    operations: ["transactions.page"],
    legacy: [stream("transactions")],
  },
  {
    key: "transactions.backfill", file: "transactions", subject: "page", kind: "goal", class: "planned",
    triggers: ["owner", "new_page"], slo: {},
    proof: "offset_stable_total", walk: "offset-walk", http: true, evidence: false, fence: "dm_archive",
    operations: ["transactions.page"],
    legacy: [stream("transactions")],
  },

  // ── top-spenders (S2-07b) ─────────────────────────────────────────────────
  {
    // Owner decision 2026-09-30: every 6 hours.
    key: "top-spenders.window", file: "top-spenders", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: 6 * HOUR }, slo: { staleAfterMs: 18 * HOUR },
    proof: "snapshot", walk: "single", http: true, evidence: false, fence: "none",
    operations: ["earnings.accounts"], replayKinds: ["earnings_accounts"],
    legacy: [stream("top_spenders")],
  },
  {
    key: "top-spenders.bootstrap", file: "top-spenders", subject: "page", kind: "goal", class: "planned",
    triggers: ["owner", "new_page"], slo: {},
    proof: "snapshot", walk: "windows", http: true, evidence: false, fence: "none",
    operations: ["earnings.accounts"],
    legacy: [stream("top_spenders")],
  },

  // ── fan-earnings (S2-07b) ─────────────────────────────────────────────────
  {
    key: "fan-earnings.roster", file: "fan-earnings", subject: "page", kind: "goal", class: "planned",
    triggers: ["projection_queue", "poll"], cadence: { everyMs: DAY }, slo: { staleAfterMs: 3 * DAY },
    proof: "receipt", walk: "subject-queue", http: true, evidence: false, fence: "none",
    operations: ["earnings.stats_accounts", "earnings.monthly_accounts"],
    replayKinds: ["fan_earnings_stats", "fan_earnings_monthly"],
    terminalStatuses: [400, 404, 410], subjectQueue: true, queuePlane: "fan_earnings_lifetime",
    legacy: [stream("fan_earnings")],
  },

  // ── purchases (S2-07b) ────────────────────────────────────────────────────
  {
    key: "purchases.targets", file: "purchases", subject: "page", kind: "goal", class: "planned",
    triggers: ["apply:transactions.*", "apply:dm-messages.*", "ws:order"],
    cadence: { everyMs: 4 * HOUR }, slo: { staleAfterMs: 12 * HOUR },
    proof: "empty_page", walk: "subject-queue", http: true, evidence: true, fence: "none",
    operations: ["media.order_history"], replayKinds: ["purchase_history"],
    terminalStatuses: [404, 410, 422], subjectQueue: true, queuePlane: "purchase_history",
    legacy: [stream("purchase_history")],
  },

  // ── payouts (S2-07b) ──────────────────────────────────────────────────────
  {
    key: "payouts.daily", file: "payouts", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll", "ws:payout_request", "ws:transaction"], period: { everyMs: DAY }, slo: { staleAfterMs: 3 * DAY },
    proof: "snapshot", walk: "snapshot-sequence", http: true, evidence: false, fence: "none",
    operations: ["payouts.methods", "payouts.requests"], replayKinds: ["payout_methods", "payout_requests"],
    legacy: [stream("payouts")],
  },
  {
    key: "payouts.walk", file: "payouts", subject: "page", kind: "goal", class: "planned",
    triggers: ["apply:payouts.daily"], slo: {},
    proof: "offset_stable", walk: "offset-walk", http: true, evidence: false, fence: "none",
    operations: ["payouts.requests"],
    legacy: [stream("payouts")],
  },

  // ── subscribers (S2-07a) ──────────────────────────────────────────────────
  {
    key: "subscribers.poll", file: "subscribers", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll", "ws:subscription", "ws_gap"], period: { everyMs: HOUR }, slo: { staleAfterMs: 3 * HOUR },
    proof: "offset_stable", walk: "offset-walk", http: true, evidence: false, fence: "none",
    operations: ["subscribers.page"], replayKinds: ["subscribers"],
    legacy: [stream("subscribers")],
    module: subscribersModule("poll"),
  },
  {
    key: "subscribers.history", file: "subscribers", subject: "page", kind: "goal", class: "planned",
    triggers: ["owner"], slo: {},
    proof: "offset_stable", walk: "offset-walk", http: true, evidence: false, fence: "none",
    operations: ["subscribers.page"],
    legacy: [stream("subscribers")],
    module: subscribersModule("history"),
  },

  // ── followers (S2-07a) ────────────────────────────────────────────────────
  {
    key: "followers.head", file: "followers", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: HOUR }, slo: { staleAfterMs: 3 * HOUR },
    proof: "head_known_item", walk: "incremental-head", http: true, evidence: false, fence: "none",
    operations: ["followers.page"], replayKinds: ["followers"],
    legacy: [stream("followers")],
    module: followersModule("head"),
  },
  {
    key: "followers.reconcile", file: "followers", subject: "page", kind: "goal", class: "planned",
    // One full walk a day after the previous start (#330), the floor both
    // engines keep.
    triggers: ["apply:followers.head", "owner"], minIntervalMs: FOLLOWERS_RECONCILE_MIN_INTERVAL_MS,
    slo: { staleAfterMs: 3 * DAY },
    proof: "reconcile_membership", walk: "offset-walk", http: true, evidence: false, fence: "none",
    operations: ["account.me", "followers.page"],
    legacy: [stream("followers_reconcile")],
    module: followersModule("reconcile"),
  },

  // ── fan-profiles (S2-07a) ─────────────────────────────────────────────────
  {
    key: "fan-profiles.lookup", file: "fan-profiles", subject: "page", kind: "goal", class: "planned",
    triggers: ["apply:subscribers.*", "apply:followers.*", "apply:transactions.*", "dependency"],
    cadence: { everyMs: DAY }, slo: {},
    proof: "snapshot", walk: "subject-queue", http: true, evidence: false, fence: "none",
    operations: ["accounts.by_ids"], replayKinds: ["account_lookup"],
    legacy: [stream("subscribers"), stream("followers"), stream("followers_reconcile")],
    module: fanProfilesModule("lookup"),
  },
  {
    key: "fan-profiles.probe", file: "fan-profiles", subject: "fan", kind: "trigger", class: "planned",
    triggers: ["apply:dm-conversations.*", "apply:dm-messages.*"], slo: {},
    proof: "snapshot", walk: "single", http: true, evidence: false, fence: "none",
    operations: ["accounts.by_ids"],
    legacy: [stream("dm_conversations"), stream("dm_messages")],
    module: fanProfilesModule("probe"),
  },
  {
    key: "fan-profiles.alias-backfill", file: "fan-profiles", subject: "page", kind: "goal", class: "planned",
    triggers: ["owner"], slo: {},
    proof: "snapshot", walk: "cursor-walk", http: true, evidence: false, fence: "none",
    operations: ["accounts.by_ids"],
    legacy: [sender("alias_backfill")],
    module: fanProfilesModule("alias-backfill"),
  },

  // ── notifications (S2-09a) ────────────────────────────────────────────────
  {
    // Hard 30 min: the only lossy source (a liker or reply is announced once).
    key: "notifications.forward", file: "notifications", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: 30 * MINUTE }, slo: { staleAfterMs: HOUR },
    proof: "head_known_item", walk: "cursor-walk", http: true, evidence: true, fence: "none",
    operations: ["notifications.page"], replayKinds: ["notifications"],
    legacy: [stream("notifications")],
    module: notificationsModule("forward"),
  },
  {
    key: "notifications.backfill", file: "notifications", subject: "page", kind: "goal", class: "planned",
    triggers: ["owner", "legacy_import"], slo: {},
    proof: "empty_page", walk: "cursor-walk", http: true, evidence: true, fence: "none",
    operations: ["notifications.page"],
    legacy: [stream("notifications")],
    module: notificationsModule("backfill"),
  },

  // ── posts (S2-09a) ────────────────────────────────────────────────────────
  {
    key: "posts.refresh", file: "posts", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: 6 * HOUR }, slo: { staleAfterMs: 18 * HOUR },
    proof: "head_known_item", walk: "cursor-walk", http: true, evidence: false, fence: "none",
    operations: ["posts.timeline", "posts.tips"], replayKinds: ["posts", "post_tips"],
    legacy: [stream("posts")],
    module: postsModule("refresh"),
  },
  {
    key: "posts.backfill", file: "posts", subject: "page", kind: "goal", class: "planned",
    triggers: ["owner", "legacy_import"], slo: {},
    proof: "empty_page", walk: "cursor-walk", http: true, evidence: false, fence: "none",
    operations: ["posts.timeline", "posts.tips"],
    legacy: [stream("posts")],
    module: postsModule("backfill"),
  },
  {
    // A standing walk over the `post_engagement` queue the creator-posts
    // projector seeds (design §4.3); it re-checks the queue every 6 h when
    // nothing is due (the legacy phase rode the 6-hourly posts cadence).
    key: "posts.engagement", file: "posts", subject: "page", kind: "goal", class: "planned",
    triggers: ["projection_queue"],
    tiers: [{ maxAgeDays: 30, everyMs: DAY }, { maxAgeDays: 180, everyMs: 7 * DAY }, { maxAgeDays: null, everyMs: 30 * DAY }],
    standing: { recheckMs: 6 * HOUR }, slo: { staleAfterMs: 3 * DAY },
    proof: "snapshot", walk: "subject-queue", http: true, evidence: false, fence: "none",
    operations: ["posts.by_ids"], subjectQueue: true, queuePlane: "post_engagement",
    legacy: [stream("posts")],
    module: postsModule("engagement"),
  },

  // ── post-replies (S2-09a) ─────────────────────────────────────────────────
  {
    // A standing walk over the `post_replies` queue (design §4.3): a post is
    // due never walked, dirty, or `fanslyRepliesRewalkCycleDays` (live, prod
    // 30 d) after its last walk; the queue is re-checked every 6 h when
    // nothing is due (the legacy stream's cadence).
    key: "post-replies.walk", file: "post-replies", subject: "page", kind: "goal", class: "planned",
    triggers: ["projection_queue"], standing: { recheckMs: 6 * HOUR }, slo: { staleAfterMs: 3 * DAY },
    proof: "empty_page", walk: "subject-queue", http: true, evidence: true, fence: "none",
    operations: ["post.replies"], replayKinds: ["post_replies"], subjectQueue: true, queuePlane: "post_replies",
    legacy: [stream("post_replies")],
    module: postRepliesModule("walk"),
  },
  {
    key: "post-replies.authors", file: "post-replies", subject: "page", kind: "trigger", class: "planned",
    triggers: ["apply:post-replies.walk"], slo: {},
    proof: "snapshot", walk: "single", http: true, evidence: false, fence: "none",
    operations: ["accounts.by_ids"],
    legacy: [stream("post_replies")],
    module: postRepliesModule("authors"),
  },

  // ── catalog (S2-09b; owner decision №6 "экономно") ────────────────────────
  {
    key: "catalog.fixed", file: "catalog", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: DAY }, slo: { staleAfterMs: 3 * DAY },
    proof: "snapshot", walk: "snapshot-sequence", http: true, evidence: false, fence: "none", ownerProtected: true,
    operations: ["vault.albums", "uservault.albums", "subscriptions.tiers", "subscriptions.giftcodes", "message.automated", "account.walls"],
    replayKinds: ["vault_albums", "uservault_albums", "subscription_tiers", "gift_codes", "automated_messages", "account_walls"],
    legacy: [stream("catalog")],
  },
  {
    // Incremental daily, full weekly.
    key: "catalog.vault", file: "catalog", subject: "page", kind: "goal", class: "planned",
    triggers: ["poll"], cadence: { everyMs: DAY, fullEveryMs: 7 * DAY }, slo: { staleAfterMs: 3 * DAY },
    proof: "vault_walk", walk: "cursor-walk", http: true, evidence: true, fence: "none", ownerProtected: true,
    operations: ["vault.media"], replayKinds: ["vault_media"],
    legacy: [stream("catalog")],
  },
  {
    key: "catalog.hydrate", file: "catalog", subject: "page", kind: "trigger", class: "planned",
    triggers: ["apply:catalog.*"], slo: {},
    proof: "snapshot", walk: "single", http: true, evidence: false, fence: "none",
    operations: ["account.media_by_ids", "account.bundles_by_ids"],
    replayKinds: ["account_media_batch", "account_media_bundle_batch"],
    legacy: [stream("catalog")],
  },

  // ── media-stats (S2-09b; owner decision №6) ───────────────────────────────
  {
    key: "media-stats.walk", file: "media-stats", subject: "page", kind: "goal", class: "planned",
    triggers: ["projection_queue", "poll"],
    tiers: [{ maxAgeDays: 30, everyMs: DAY }, { maxAgeDays: 90, everyMs: 7 * DAY }, { maxAgeDays: null, everyMs: 30 * DAY }],
    slo: { staleAfterMs: 3 * DAY },
    proof: "window_honoured", walk: "subject-queue", http: true, evidence: false, fence: "none", ownerProtected: true,
    operations: ["media.offer_stats"], replayKinds: ["media_offer_stats"], subjectQueue: true, queuePlane: "media_stats",
    legacy: [stream("media_stats")],
  },

  // ── stats (S2-09b) ────────────────────────────────────────────────────────
  {
    key: "stats.daily", file: "stats", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: DAY }, slo: { staleAfterMs: 3 * DAY },
    proof: "snapshot", walk: "snapshot-sequence", http: true, evidence: false, fence: "none",
    operations: STATS_DAILY_OPERATIONS,
    replayKinds: [
      "account_stats", "earnings_stats_snapshot", "earnings_monthlystats_snapshot", "tracking_links", "discovery_feed",
      "broadcast_stats", "broadcast_stats_deleted", "broadcast_scheduled", "polls", "recapstats",
    ],
    legacy: [stream("stats_snapshot")],
  },
  {
    // Every ≤ 25 h window stays gap-free [A15].
    key: "stats.hourly", file: "stats", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: 22 * HOUR }, slo: { staleAfterMs: 66 * HOUR },
    proof: "window_honoured", walk: "single", http: true, evidence: false, fence: "none",
    operations: ["account.stats"],
    legacy: [stream("stats_snapshot")],
  },
  {
    key: "stats.backfill", file: "stats", subject: "page", kind: "goal", class: "planned",
    triggers: ["owner", "legacy_import"], slo: {},
    proof: "window_honoured", walk: "windows", http: true, evidence: false, fence: "none",
    operations: ["account.stats"],
    legacy: [stream("stats_snapshot")],
  },

  // ── live only (step 3) ────────────────────────────────────────────────────
  {
    key: "media-download.fetch", file: "media-download", subject: "media", kind: "trigger", class: "planned",
    triggers: ["api"], slo: {},
    proof: "snapshot", walk: "single", http: true, liveOnly: true, evidence: false, fence: "dm_archive",
    operations: [],
    legacy: [sender("media_download")],
  },
  {
    key: "repair.ws-gap", file: "repair", subject: "page", kind: "repair", class: "urgent",
    triggers: ["ws_gap"], slo: { resultMs: MINUTE },
    proof: "none", walk: "composite", http: true, liveOnly: true, evidence: false, fence: "dm_archive",
    operations: ["messaging.groups"],
    legacy: [],
  },

  // ── probe (S2-09b) ────────────────────────────────────────────────────────
  {
    key: "probe.manual", file: "probe", subject: "page", kind: "trigger", class: "planned",
    triggers: ["owner"], slo: {},
    proof: "none", walk: "single", http: true, evidence: false, fence: "none",
    operations: [],
    legacy: [sender("endpoint_probe"), sender("replay_probe")],
  },
];

/**
 * The step-1 overlay apply is the `dm-live.frame` resource (design §5.5): a
 * WS frame applied in the transaction that acks its receipt — not a work row,
 * no request, so not an engine entry.
 */
export const FANSLY_LIVE_FRAME_RESOURCE = {
  key: "dm-live.frame",
  triggers: ["ws:*"] as readonly Trigger[],
  slo: { visibleP95Ms: 5 * SECOND },
} as const;

/** Legacy streams and senders no entry takes over (design §4.5). */
export const FANSLY_LEGACY_UNMAPPED: readonly LegacyDisposition[] = [
  {
    ref: stream("fan_identities"),
    disposition: "retired",
    reason: "OnlyFans only: Fansly pages never ran the stream",
  },
  {
    ref: sender("sync_stream"),
    disposition: "by_streams",
    reason: "the stream chunks themselves: covered stream by stream",
  },
  {
    ref: sender("onboarding"),
    disposition: "stays_legacy",
    reason: "no page exists yet: the step-1 no-page guard until step 4 (D4, §11.4)",
  },
  {
    ref: sender("credentials_verify"),
    disposition: "stays_legacy",
    reason: "no page: the step-1 no-page guard until step 4 (D4, §11.4)",
  },
  {
    ref: sender("ws_probe"),
    disposition: "retired",
    reason: "operator scripts refuse pages in handover or live",
  },
];

/** The spec of a key, or null. */
export function fanslyResourceSpec(key: string): ResourceSpec | null {
  return FANSLY_RESOURCE_SPECS.find((spec) => spec.key === key) ?? null;
}

/** The entry that replays an observation kind for the shadow report. */
export function fanslyReplayOwner(kind: string): ResourceSpec | null {
  return FANSLY_RESOURCE_SPECS.find((spec) => spec.replayKinds?.includes(kind as FanslyObservationKind) === true) ?? null;
}

export function createFanslyRegistry(options: { metrics?: Metrics } = {}): EngineRegistry {
  return createEngineRegistry(FANSLY_RESOURCE_SPECS, options);
}
