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
// `dependency` and counts `sync_not_implemented` (S2-08a … S3-04 filled them).

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

export type { TierSpec } from "../engine/resource.ts";

export interface ResourceSpec extends EngineResourceSpec {
  file: ResourceFile;
  /** What one work row is about. */
  subject: "page" | "thread" | "target" | "fan" | "post" | "media";
  triggers: readonly Trigger[];
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
const dmConversationsModule = (variant: "head" | "full" | "find" | "detail" | "ws-down") => async (): Promise<ResourceModule> =>
  (await import("./resources/dm-conversations.ts")).dmConversationsModule(variant);
const transactionsModule = (variant: "head" | "insurance" | "rescan" | "backfill") => async (): Promise<ResourceModule> =>
  (await import("./resources/transactions.ts")).transactionsModule(variant);
const topSpendersModule = (variant: "window" | "bootstrap") => async (): Promise<ResourceModule> =>
  (await import("./resources/top-spenders.ts")).topSpendersModule(variant);
const fanEarningsModule = async (): Promise<ResourceModule> =>
  (await import("./resources/fan-earnings.ts")).fanEarningsRosterModule;
const purchasesModule = async (): Promise<ResourceModule> =>
  (await import("./resources/purchases.ts")).purchasesTargetsModule;
const payoutsModule = (variant: "daily" | "walk") => async (): Promise<ResourceModule> =>
  (await import("./resources/payouts.ts")).payoutsModule(variant);
const dmMessagesModule = (variant: "head" | "catchup" | "history") => async (): Promise<ResourceModule> =>
  (await import("./resources/dm-messages.ts")).dmMessagesModule(variant);
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

const dmLiveDeletionsModule = async (): Promise<ResourceModule> =>
  (await import("./resources/dm-live.ts")).dmLiveDeletionsModule;
const notificationsModule = (variant: "forward" | "backfill") => async (): Promise<ResourceModule> =>
  (await import("./resources/notifications.ts")).notificationsModule(variant);
const postsModule = (variant: "refresh" | "backfill" | "engagement") => async (): Promise<ResourceModule> =>
  (await import("./resources/posts.ts")).postsModule(variant);
const postRepliesModule = (variant: "walk" | "authors") => async (): Promise<ResourceModule> =>
  (await import("./resources/post-replies.ts")).postRepliesModule(variant);
const catalogModule = (variant: "fixed" | "vault" | "hydrate") => async (): Promise<ResourceModule> =>
  (await import("./resources/catalog.ts")).catalogModule(variant);
const mediaStatsModule = async (): Promise<ResourceModule> =>
  (await import("./resources/media-stats.ts")).mediaStatsWalkModule;
const statsModule = (variant: "daily" | "hourly" | "backfill") => async (): Promise<ResourceModule> =>
  (await import("./resources/stats.ts")).statsModule(variant);
const probeModule = async (): Promise<ResourceModule> =>
  (await import("./resources/probe.ts")).probeManualModule;
const probeExcludedChatModule = async (): Promise<ResourceModule> =>
  (await import("./resources/probe.ts")).probeExcludedChatModule;
const wsConnectModule = async (): Promise<ResourceModule> =>
  (await import("./resources/ws-connect.ts")).wsConnectModule;
const mediaDownloadModule = async (): Promise<ResourceModule> =>
  (await import("./resources/media-download.ts")).mediaDownloadModule;
const repairModule = async (): Promise<ResourceModule> =>
  (await import("./resources/repair.ts")).repairWsGapModule;

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
    // A candidate session/proxy checked before it is stored (step-3 §3.5
    // item 6). Its 401/403 is the CANDIDATE's refusal, not the stored
    // session's: the check closes with it and holds nothing (G16 mechanism,
    // step-3 deviation); it runs under an auth hold of the stored session
    // (E16) and so must never re-arm one.
    key: "account.identity", file: "account", subject: "page", kind: "trigger", class: "urgent",
    triggers: ["api", "owner"], slo: { resultMs: 30 * SECOND },
    proof: "snapshot", walk: "single", http: true, liveOnly: true, evidence: false, fence: "none",
    subjectScopedAuthStatuses: [401, 403],
    operations: ["account.me"],
    legacy: [sender("account_me_api"), sender("account_me_cli"), sender("binding_preflight")],
    module: accountModule("identity"),
  },

  // ── ws (step 3) ───────────────────────────────────────────────────────────
  {
    // The socket's Upgrade (S3-04): asked for by the page's socket owner at
    // start and after every close (its reconnect ladder), one admission per
    // Upgrade. A failed handshake goes back to that ladder, never to the
    // page's network streak.
    key: "ws.connect", file: "ws", subject: "page", kind: "trigger", class: "urgent",
    triggers: ["ws_lifecycle"], slo: {},
    proof: "none", walk: "single", http: true, liveOnly: true, evidence: false, fence: "none",
    operations: ["ws.upgrade"],
    legacy: [sender("ws_connect")],
    module: wsConnectModule,
  },

  // ── dm-live (no HTTP; S2-10 routes it, S3-03 writes it) ───────────────────
  {
    key: "dm-live.deletions", file: "dm-live", subject: "thread", kind: "trigger", class: "urgent",
    triggers: ["ws:message_deleted"],
    coalesce: { quietMs: 0, maxMs: SECOND, extendOnSignal: false }, slo: { resultMs: 5 * SECOND },
    proof: "none", walk: "none", http: false, evidence: false, fence: "dm_archive",
    operations: [],
    legacy: [],
    module: dmLiveDeletionsModule,
  },

  // ── dm-conversations (S2-08a) ─────────────────────────────────────────────
  {
    key: "dm-conversations.head", file: "dm-conversations", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: 30 * MINUTE }, slo: { staleAfterMs: 90 * MINUTE },
    proof: "head_known_item", walk: "offset-walk", http: true, evidence: false, fence: "dm_archive",
    operations: ["messaging.groups"], replayKinds: ["dm_conversations"],
    legacy: [stream("dm_conversations")],
    module: dmConversationsModule("head"),
  },
  {
    key: "dm-conversations.full", file: "dm-conversations", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: DAY }, slo: { staleAfterMs: 3 * DAY },
    proof: "offset_stable", walk: "offset-walk", http: true, evidence: false, fence: "dm_archive",
    operations: ["messaging.groups"],
    legacy: [stream("dm_conversations")],
    module: dmConversationsModule("full"),
  },
  {
    // Planned before the HTTP gate too (ruling 9): what its plan settles
    // without a request (a wait for the page's identity; a closure, once a
    // list read answered the find) commits there with no slot; its reads
    // wait for theirs.
    key: "dm-conversations.find", file: "dm-conversations", subject: "thread", kind: "trigger", class: "urgent",
    triggers: ["ws:group_created", "ws:message_unknown_chat", "dependency"],
    coalesce: { quietMs: 0, maxMs: 0, extendOnSignal: false }, slo: { resultMs: 12 * SECOND },
    proof: "snapshot", walk: "single", http: true, planBeforeGate: true, evidence: false, fence: "dm_archive",
    operations: ["messaging.groups", "group.detail"], replayKinds: ["group_detail"],
    legacy: [stream("dm_conversations"), sender("ws_hint")],
    module: dmConversationsModule("find"),
  },
  {
    key: "dm-conversations.detail", file: "dm-conversations", subject: "thread", kind: "trigger", class: "planned",
    triggers: ["apply:dm-conversations.*"], slo: {},
    proof: "snapshot", walk: "single", http: true, evidence: false, fence: "dm_archive",
    operations: ["group.detail"],
    legacy: [stream("dm_conversations")],
    module: dmConversationsModule("detail"),
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
    module: dmConversationsModule("ws-down"),
  },

  // ── dm-messages (S2-08b) ──────────────────────────────────────────────────
  {
    key: "dm-messages.head", file: "dm-messages", subject: "thread", kind: "trigger", class: "urgent",
    triggers: [
      "ws:message_created", "ws:message_invalid_known_chat", "apply:dm-conversations.ws-down",
      "apply:dm-conversations.find", "ws_gap",
    ],
    coalesce: { quietMs: 5 * SECOND, maxMs: 20 * SECOND, extendOnSignal: true, fast: { quietMs: 2 * SECOND, maxMs: 6 * SECOND } },
    slo: { resultMs: 30 * SECOND },
    proof: "chain_empty_page", walk: "incremental-head", http: true, evidence: true, fence: "dm_archive",
    operations: ["messages.page"], replayKinds: ["dm_messages"],
    legacy: [stream("dm_messages"), sender("ws_hint"), sender("ai_accelerator"), sender("ai_fast_lane")],
    module: dmMessagesModule("head"),
  },
  {
    key: "dm-messages.catchup", file: "dm-messages", subject: "thread", kind: "trigger", class: "planned",
    triggers: ["apply:dm-conversations.head", "apply:dm-conversations.full", "apply:dm-conversations.detail", "legacy_import"],
    coalesce: { quietMs: MINUTE, maxMs: 10 * MINUTE, extendOnSignal: true }, slo: { staleAfterMs: 6 * HOUR },
    proof: "chain_empty_page", walk: "incremental-head", http: true, evidence: true, fence: "dm_archive",
    operations: ["messages.page"],
    legacy: [stream("dm_messages"), stream("dm_conversations")],
    module: dmMessagesModule("catchup"),
  },
  {
    // I12: no history walk without a request (owner decision №2).
    key: "dm-messages.history", file: "dm-messages", subject: "thread", kind: "goal", class: "requests",
    triggers: ["request"], slo: {},
    proof: "chain_empty_page", walk: "cursor-walk", http: true, evidence: true, fence: "dm_archive",
    operations: ["messages.page"],
    legacy: [stream("dm_messages"), sender("targeted_backfill")],
    module: dmMessagesModule("history"),
  },

  // ── transactions (S2-07b) ─────────────────────────────────────────────────
  {
    key: "transactions.head", file: "transactions", subject: "page", kind: "trigger", class: "urgent",
    triggers: ["ws:transaction", "ws:order", "ws:wallet", "ws:subscription", "ws_gap"],
    coalesce: { quietMs: 2 * SECOND, maxMs: 2 * SECOND, extendOnSignal: false }, slo: { resultMs: 15 * SECOND },
    proof: "head_known_item", walk: "offset-walk", http: true, evidence: false, fence: "dm_archive",
    operations: ["transactions.page"], replayKinds: ["earnings_transactions"],
    legacy: [stream("transactions")],
    module: transactionsModule("head"),
  },
  {
    // Owner decision №5: the insurance poll every 5 minutes.
    key: "transactions.insurance", file: "transactions", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: 5 * MINUTE }, slo: { staleAfterMs: 15 * MINUTE },
    proof: "head_known_item", walk: "offset-walk", http: true, evidence: false, fence: "dm_archive",
    operations: ["transactions.page"],
    legacy: [stream("transactions")],
    module: transactionsModule("insurance"),
  },
  {
    key: "transactions.rescan", file: "transactions", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll", "ws:transaction", "apply:transactions.head"], period: { everyMs: HOUR }, slo: { staleAfterMs: 3 * HOUR },
    proof: "offset_stable_total", walk: "offset-walk", http: true, evidence: false, fence: "dm_archive",
    operations: ["transactions.page"],
    legacy: [stream("transactions")],
    module: transactionsModule("rescan"),
  },
  {
    key: "transactions.backfill", file: "transactions", subject: "page", kind: "goal", class: "planned",
    triggers: ["owner", "new_page", "dependency"], slo: {},
    proof: "offset_stable_total", walk: "offset-walk", http: true, evidence: false, fence: "dm_archive",
    operations: ["transactions.page"],
    legacy: [stream("transactions")],
    module: transactionsModule("backfill"),
  },

  // ── top-spenders (S2-07b) ─────────────────────────────────────────────────
  {
    // Owner decision 2026-09-30: every 6 hours.
    key: "top-spenders.window", file: "top-spenders", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: 6 * HOUR }, slo: { staleAfterMs: 18 * HOUR },
    proof: "snapshot", walk: "single", http: true, evidence: false, fence: "none",
    operations: ["earnings.accounts"], replayKinds: ["earnings_accounts"],
    legacy: [stream("top_spenders")],
    module: topSpendersModule("window"),
  },
  {
    key: "top-spenders.bootstrap", file: "top-spenders", subject: "page", kind: "goal", class: "planned",
    triggers: ["owner", "new_page"], slo: {},
    proof: "snapshot", walk: "windows", http: true, evidence: false, fence: "none",
    operations: ["earnings.accounts"],
    legacy: [stream("top_spenders")],
    module: topSpendersModule("bootstrap"),
  },

  // ── fan-earnings (S2-07b) ─────────────────────────────────────────────────
  {
    // The transactions steps (≥ every 5 min) ask for a walk whenever a subject
    // is due: dirty (projection queue) or past the roster age (poll-like). No
    // standing row: between walks the queue alone says when the next is due
    // (the shadow walks its due roster at most once a `cadence`).
    key: "fan-earnings.roster", file: "fan-earnings", subject: "page", kind: "goal", class: "planned",
    triggers: ["projection_queue", "poll", "apply:transactions.*"], cadence: { everyMs: DAY }, slo: { staleAfterMs: 3 * DAY },
    proof: "receipt", walk: "subject-queue", http: true, evidence: false, fence: "none",
    operations: ["earnings.stats_accounts", "earnings.monthly_accounts"],
    replayKinds: ["fan_earnings_stats", "fan_earnings_monthly"],
    terminalStatuses: [400, 404, 410], subjectQueue: true, queuePlane: "fan_earnings_lifetime",
    legacy: [stream("fan_earnings")],
    module: fanEarningsModule,
  },

  // ── purchases (S2-07b) ────────────────────────────────────────────────────
  {
    // One row per target (`media:<id>` | `bundle:<id>`): the plane CHECK of
    // subject_refresh_state admits no `purchase_history` plane (S2-07b).
    key: "purchases.targets", file: "purchases", subject: "target", kind: "goal", class: "planned",
    triggers: ["apply:transactions.*", "apply:dm-messages.*", "ws:order"],
    slo: { staleAfterMs: 12 * HOUR },
    proof: "empty_page", walk: "cursor-walk", http: true, evidence: true, fence: "none",
    operations: ["media.order_history"], replayKinds: ["purchase_history"],
    terminalStatuses: [404, 410, 422],
    legacy: [stream("purchase_history")],
    module: purchasesModule,
  },

  // ── payouts (S2-07b) ──────────────────────────────────────────────────────
  {
    key: "payouts.daily", file: "payouts", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll", "ws:payout_request", "ws:transaction"], period: { everyMs: DAY }, slo: { staleAfterMs: 3 * DAY },
    proof: "snapshot", walk: "snapshot-sequence", http: true, evidence: false, fence: "none",
    operations: ["payouts.methods", "payouts.requests"], replayKinds: ["payout_methods", "payout_requests"],
    legacy: [stream("payouts")],
    module: payoutsModule("daily"),
  },
  {
    key: "payouts.walk", file: "payouts", subject: "page", kind: "goal", class: "planned",
    triggers: ["apply:payouts.daily"], slo: {},
    proof: "offset_stable", walk: "offset-walk", http: true, evidence: false, fence: "none",
    operations: ["payouts.requests"],
    legacy: [stream("payouts")],
    module: payoutsModule("walk"),
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
    // Demand only: the applies name the fans whose profile was not read
    // through the page within a day (the 24 h reuse per fan is
    // `FANSLY_ACCOUNT_LOOKUP_REUSE_MS`, read by `partitionLookupIds`; no
    // cadence of its own).
    key: "fan-profiles.lookup", file: "fan-profiles", subject: "page", kind: "goal", class: "planned",
    triggers: ["apply:subscribers.*", "apply:followers.*", "apply:transactions.*", "dependency"],
    slo: {},
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
    module: catalogModule("fixed"),
  },
  {
    // A standing walk over the albums the catalog projection lists: it looks
    // at them daily (an album whose head or count moved is walked again —
    // incremental daily) and an album walked a week ago is due again (full
    // weekly; a page's override changes either period, owner decision №6);
    // `catalog.fixed` makes it due as soon as it listed the albums.
    key: "catalog.vault", file: "catalog", subject: "page", kind: "goal", class: "planned",
    triggers: ["poll", "apply:catalog.fixed"], cadence: { everyMs: DAY, fullEveryMs: 7 * DAY }, pageOverride: "cadence",
    standing: { recheckMs: DAY }, slo: { staleAfterMs: 3 * DAY },
    proof: "vault_walk", walk: "cursor-walk", http: true, evidence: true, fence: "none", ownerProtected: true,
    operations: ["vault.media"], replayKinds: ["vault_media"],
    legacy: [stream("catalog")],
    module: catalogModule("vault"),
  },
  {
    key: "catalog.hydrate", file: "catalog", subject: "page", kind: "trigger", class: "planned",
    triggers: ["apply:catalog.*"], slo: {},
    proof: "snapshot", walk: "single", http: true, evidence: false, fence: "none",
    operations: ["account.media_by_ids", "account.bundles_by_ids"],
    replayKinds: ["account_media_batch", "account_media_bundle_batch"],
    legacy: [stream("catalog")],
    module: catalogModule("hydrate"),
  },

  // ── media-stats (S2-09b; owner decision №6) ───────────────────────────────
  {
    // A standing walk over the `media_stats` queue the media-plane and
    // engagement projectors seed and dirty (design §4.3); it re-checks the
    // queue every 6 h when nothing is due (the legacy stream's cadence). The
    // tiers are the queue's: ≤ 30 d daily, 31–90 d weekly, older monthly (D19);
    // a page's override replaces them (owner decision №6, `--owner-approved`).
    key: "media-stats.walk", file: "media-stats", subject: "page", kind: "goal", class: "planned",
    triggers: ["projection_queue", "poll"],
    tiers: [{ maxAgeDays: 30, everyMs: DAY }, { maxAgeDays: 90, everyMs: 7 * DAY }, { maxAgeDays: null, everyMs: 30 * DAY }],
    pageOverride: "tiers",
    standing: { recheckMs: 6 * HOUR }, slo: { staleAfterMs: 3 * DAY },
    proof: "window_honoured", walk: "subject-queue", http: true, evidence: false, fence: "none", ownerProtected: true,
    operations: ["media.offer_stats"], replayKinds: ["media_offer_stats"], subjectQueue: true, queuePlane: "media_stats",
    legacy: [stream("media_stats")],
    module: mediaStatsModule,
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
    module: statsModule("daily"),
  },
  {
    // Every ≤ 25 h window stays gap-free [A15]; the next capture is never
    // planned past the 23 h two windows need to meet.
    key: "stats.hourly", file: "stats", subject: "page", kind: "poll", class: "planned",
    triggers: ["poll"], period: { everyMs: 22 * HOUR }, slo: { staleAfterMs: 66 * HOUR },
    proof: "window_honoured", walk: "single", http: true, evidence: false, fence: "none",
    operations: ["account.stats"],
    legacy: [stream("stats_snapshot")],
    module: statsModule("hourly"),
  },
  {
    key: "stats.backfill", file: "stats", subject: "page", kind: "goal", class: "planned",
    triggers: ["owner", "legacy_import"], slo: {},
    proof: "window_honoured", walk: "windows", http: true, evidence: false, fence: "none",
    operations: ["account.stats", "earnings.stats_window"],
    legacy: [stream("stats_snapshot")],
    module: statsModule("backfill"),
  },

  // ── live only (step 3) ────────────────────────────────────────────────────
  {
    // The AI describer's CDN download (S3-04, owner decision №17): one hop
    // per step, the URL in the work's secret; a 401/403 is the signed URL's,
    // never the page session's (G16, E8).
    key: "media-download.fetch", file: "media-download", subject: "media", kind: "trigger", class: "planned",
    triggers: ["api"], slo: {},
    proof: "snapshot", walk: "single", http: true, liveOnly: true, evidence: false, fence: "dm_archive",
    subjectScopedAuthStatuses: [401, 403],
    operations: ["cdn.media"],
    legacy: [sender("media_download")],
    module: mediaDownloadModule,
  },
  {
    // Also a frame no chat can be named for (plan §7 p.10 (b), the router).
    key: "repair.ws-gap", file: "repair", subject: "page", kind: "repair", class: "urgent",
    triggers: ["ws_gap", "ws:invalid"], slo: { resultMs: MINUTE },
    proof: "none", walk: "composite", http: true, liveOnly: true, evidence: false, fence: "dm_archive",
    operations: ["messaging.groups"],
    legacy: [],
    module: repairModule,
  },

  // ── probe (S2-09b) ────────────────────────────────────────────────────────
  {
    // Any route, one admitted request (`pnpm cli sync probe`): the route is
    // the work's parameter, so the entry names none.
    key: "probe.manual", file: "probe", subject: "page", kind: "trigger", class: "planned",
    triggers: ["owner"], slo: {},
    proof: "none", walk: "single", http: true, evidence: false, fence: "none",
    operations: [],
    legacy: [sender("endpoint_probe"), sender("replay_probe")],
    module: probeModule,
  },
  {
    // Owner decision №8 (step 3, S3-06): one head read of a chat the legacy
    // engine excluded from message sync, asked for by `sync excluded probe`.
    // A 403 is the chat's answer, never the session's (G8, E8): it closes the
    // probe `served: false` and holds nothing; a 401 and a 429 stay page-wide.
    // Journaled, never canonicalized (no DM state for an excluded chat).
    key: "probe.excluded-chat", file: "probe", subject: "thread", kind: "trigger", class: "planned",
    triggers: ["owner"], slo: {},
    proof: "none", walk: "single", http: true, liveOnly: true, evidence: false, fence: "none",
    subjectScopedAuthStatuses: [403],
    terminalStatuses: [400, 404, 410, 422],
    operations: ["messages.page"],
    legacy: [],
    module: probeExcludedChatModule,
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
