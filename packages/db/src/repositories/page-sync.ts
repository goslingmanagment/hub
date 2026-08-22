import { and, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  egressEndpoints,
  pageFollows,
  pageSyncStates,
  pages,
} from "../schema.ts";
import { egressKeySql } from "./egress.ts";

type TimestampValue = Date | string | null | undefined;
type NumericValue = number | bigint | null | undefined;

export const SYNC_STREAMS = [
  "light",
  "fan_identities",
  "transactions",
  "top_spenders",
  "subscribers",
  "followers",
  "followers_reconcile",
  "dm_conversations",
  "dm_messages",
  "fan_earnings",
  "purchase_history",
  "posts",
  // WP-F1: the account-level statistics sweep (maintenance, 6 h cadence; the
  // daily-slot logic lives inside the handler). Fansly-only, gated off, and
  // seeded PAUSED like `posts` — see SEED_PAUSED_SYNC_STREAMS below.
  "stats_snapshot",
  // WP-F2: the notification poll. LIVE class on a 1 800 s cadence, because it
  // is the only PERMANENTLY-LOSSY lane in the system — a liker, a reply or a
  // quote is announced once and never re-served, so an hour of downtime is an
  // hour of facts nobody can recover. Fansly-only, gated off, seeded PAUSED.
  "notifications",
  // WP-F3: the daily content-catalog sweep — both vaults, tiers, gift codes,
  // automated messages, walls, and the vault media walk that MEASURES M. It is
  // maintenance class at 86 400 s because inventory moves in days, and it runs
  // BEFORE the per-media lane exists on purpose: M is what sizes that lane.
  // Fansly-only, gated off, seeded PAUSED.
  "catalog",
  // WP-F5: the comment archive walk. HISTORY class at 21 600 s — it is a big
  // back-catalogue (≈4 300 Fansly roots fleet-wide) read at 100 calls a page a
  // day, so it is never "fresh" and never urgent; what it must not do is burst.
  // Fansly-only, gated off, seeded PAUSED.
  "post_replies",
  // WP-F7: the money-out lane. MAINTENANCE class at 86 400 s — two routes, two
  // calls a day in steady state, and the only thing that ever costs more is the
  // one-off offset walk of the payout-request history (nine calls on the walked
  // page). Fansly-only, gated off, seeded PAUSED.
  "payouts",
  // WP-F4: the per-media statistics lane. HISTORY class at 21 600 s — one call
  // per media per window over the WHOLE catalogue, age-decayed, and the only
  // lane in this initiative deliberately sized to sit at 100 % of its own daily
  // cap when M is large (A16). It depends on `catalog`, which is what MEASURES
  // M. Fansly-only, gated off, seeded PAUSED.
  "media_stats",
] as const;

export type SyncStream = typeof SYNC_STREAMS[number];

export const SYNC_DOMAINS = [
  "connection",
  "financials",
  "audience",
  "messages_live",
  "messages_history",
] as const;

export type SyncDomain = typeof SYNC_DOMAINS[number];
export type PageSyncStatus = "idle" | "pending" | "running" | "retrying" | "blocked" | "paused";
export type SyncRequestSource =
  | "scheduled"
  | "manual"
  | "onboarding"
  | "recovery"
  | "anomaly"
  | "reset";
export type SyncWorkClass = "live" | "history" | "maintenance";

export const FANSLY_BULK_SYNC_STREAMS = [
  "fan_earnings",
  "purchase_history",
  // WP-F1: gate flips must materialize into durable pause/resume (#191/#194)
  // for this lane too, or opening its flag moves nothing until the next slot.
  "stats_snapshot",
  // WP-F2. Membership here is also what makes the never-ran seed-pause fix
  // (the reconciler's gate-owned pause rule) cover this lane: without it a
  // `notifications` row seeded paused would sit paused forever and its ramp
  // flag would move nothing — the #192 failure, reproduced on production for
  // stats_snapshot on 2026-08-22.
  "notifications",
  // WP-F3: same rule. Without membership here the lane seeds paused and its
  // ramp flag moves nothing.
  "catalog",
  // WP-F5: same rule again.
  "post_replies",
  // WP-F7: same rule again.
  "payouts",
  // WP-F4: same rule again.
  "media_stats",
] as const;

export type FanslyBulkSyncStream = typeof FANSLY_BULK_SYNC_STREAMS[number];
export type FanslyBulkStreamGateState = "ramped" | "flag_off" | "not_allowlisted";
export type FanslyBulkStreamGateAction = "paused" | "resumed" | "unchanged";

export interface FanslyBulkStreamGateReconcileResult {
  action: FanslyBulkStreamGateAction;
  createdRecoveryGeneration: boolean;
}

export const FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND = "feature_gate";

/**
 * Streams that seed PAUSED, with no blocker (paused-without-a-blocker is
 * distinguishable from a `feature_gate` pause).
 *
 * WP-F1 generalizes what used to be a hard `if (stream === "posts")`. Every
 * OTHER stream seeds `pending`/recovery, so a gated-off stream added to
 * SYNC_STREAMS without an entry here would seed one pending row per page,
 * FLEET-WIDE, on the deploy that ships it — before its flag was ever opened.
 * Ungating stays an explicit act: the gate reconciler resumes it, or an
 * operator uses the stream's own sync scope.
 */
export const SEED_PAUSED_SYNC_STREAMS = [
  "posts",
  "stats_snapshot",
  "notifications",
  "catalog",
  "post_replies",
  "payouts",
  "media_stats",
] as const;

export function isSeedPausedSyncStream(stream: string): boolean {
  return (SEED_PAUSED_SYNC_STREAMS as readonly string[]).includes(stream);
}

export interface SyncStreamPolicy {
  stream: SyncStream;
  domain: SyncDomain;
  cadenceSeconds: number;
  basePriority: number;
  streamIndex: number;
  defaultWorkClass: SyncWorkClass;
  queueDelayThresholdMs: number;
  progressStallThresholdMs: number;
  freshnessSlaSeconds: number | null;
}

export interface SyncDomainPolicy {
  domain: SyncDomain;
  primaryStreams: SyncStream[];
  supportingStreams: SyncStream[];
  freshnessSlaSeconds: number | null;
}

export interface PageSyncBlockResult {
  updated: boolean;
  blocked: boolean;
}

export interface PageSyncRetryResult {
  updated: boolean;
  retried: boolean;
}

export interface PageSyncYieldResult {
  updated: boolean;
  superseded: boolean;
}

export const SYNC_STREAM_POLICY: Record<SyncStream, SyncStreamPolicy> = {
  light: {
    stream: "light",
    domain: "connection",
    cadenceSeconds: 3600,
    basePriority: 60,
    streamIndex: 1,
    defaultWorkClass: "live",
    queueDelayThresholdMs: 10 * 60_000,
    progressStallThresholdMs: 3 * 60_000,
    freshnessSlaSeconds: 3 * 3600,
  },
  transactions: {
    stream: "transactions",
    domain: "financials",
    cadenceSeconds: 3600,
    basePriority: 50,
    streamIndex: 2,
    defaultWorkClass: "live",
    queueDelayThresholdMs: 15 * 60_000,
    progressStallThresholdMs: 5 * 60_000,
    freshnessSlaSeconds: 3 * 3600,
  },
  fan_identities: {
    stream: "fan_identities",
    domain: "financials",
    cadenceSeconds: 6 * 3600,
    basePriority: 49,
    streamIndex: 3,
    defaultWorkClass: "maintenance",
    queueDelayThresholdMs: 30 * 60_000,
    progressStallThresholdMs: 10 * 60_000,
    freshnessSlaSeconds: null,
  },
  top_spenders: {
    stream: "top_spenders",
    domain: "financials",
    cadenceSeconds: 3600,
    basePriority: 45,
    streamIndex: 4,
    defaultWorkClass: "maintenance",
    queueDelayThresholdMs: 30 * 60_000,
    progressStallThresholdMs: 10 * 60_000,
    freshnessSlaSeconds: null,
  },
  subscribers: {
    stream: "subscribers",
    domain: "audience",
    cadenceSeconds: 3600,
    basePriority: 40,
    streamIndex: 5,
    defaultWorkClass: "live",
    queueDelayThresholdMs: 15 * 60_000,
    progressStallThresholdMs: 5 * 60_000,
    freshnessSlaSeconds: 3 * 3600,
  },
  followers: {
    stream: "followers",
    domain: "audience",
    cadenceSeconds: 3600,
    basePriority: 35,
    streamIndex: 6,
    defaultWorkClass: "live",
    queueDelayThresholdMs: 15 * 60_000,
    progressStallThresholdMs: 5 * 60_000,
    freshnessSlaSeconds: 3 * 3600,
  },
  followers_reconcile: {
    stream: "followers_reconcile",
    domain: "audience",
    cadenceSeconds: 172800,
    basePriority: 34,
    streamIndex: 7,
    defaultWorkClass: "maintenance",
    queueDelayThresholdMs: 90 * 60_000,
    progressStallThresholdMs: 15 * 60_000,
    freshnessSlaSeconds: null,
  },
  dm_conversations: {
    stream: "dm_conversations",
    domain: "messages_live",
    cadenceSeconds: 1800,
    basePriority: 30,
    streamIndex: 8,
    defaultWorkClass: "live",
    queueDelayThresholdMs: 15 * 60_000,
    progressStallThresholdMs: 5 * 60_000,
    freshnessSlaSeconds: 3600,
  },
  dm_messages: {
    stream: "dm_messages",
    domain: "messages_history",
    cadenceSeconds: 86400,
    basePriority: 25,
    streamIndex: 9,
    defaultWorkClass: "history",
    queueDelayThresholdMs: 45 * 60_000,
    progressStallThresholdMs: 15 * 60_000,
    freshnessSlaSeconds: null,
  },
  // Stage 16: Fansly-only bulk streams — lowest priority, never ahead of
  // transactions/DMs, and deliberately ABSENT from SYNC_DOMAIN_POLICY
  // supporting lists: a flag-gated bulk stream must not degrade the page's
  // block-health UX to "catching up" while its ramp gate is off.
  fan_earnings: {
    stream: "fan_earnings",
    domain: "financials",
    cadenceSeconds: 86400,
    basePriority: 20,
    streamIndex: 10,
    defaultWorkClass: "maintenance",
    queueDelayThresholdMs: 90 * 60_000,
    progressStallThresholdMs: 15 * 60_000,
    freshnessSlaSeconds: null,
  },
  purchase_history: {
    stream: "purchase_history",
    domain: "messages_history",
    cadenceSeconds: 4 * 3600,
    basePriority: 15,
    streamIndex: 11,
    defaultWorkClass: "history",
    queueDelayThresholdMs: 90 * 60_000,
    progressStallThresholdMs: 15 * 60_000,
    freshnessSlaSeconds: null,
  },
  // Creator posts ship as a durable but default-paused capture lane. Keep the
  // stream out of block-domain policy until the per-page canary is explicitly
  // opened; an inert rollout must not degrade existing page health.
  posts: {
    stream: "posts",
    domain: "messages_history",
    cadenceSeconds: 6 * 3600,
    basePriority: 14,
    streamIndex: 12,
    defaultWorkClass: "history",
    queueDelayThresholdMs: 90 * 60_000,
    progressStallThresholdMs: 30 * 60_000,
    freshnessSlaSeconds: null,
  },
  // WP-F1: the statistics sweep. `domain: "financials"` is where its revenue
  // mix belongs, but note it is deliberately ABSENT from SYNC_DOMAIN_POLICY's
  // primary/supporting lists — a flag-gated analytics stream must not degrade a
  // page's block-health UX to "catching up" while its ramp gate is off.
  // Cadence 21 600 s so a deferred day resumes within six hours; the handler
  // decides whether a daily sweep is actually due.
  stats_snapshot: {
    stream: "stats_snapshot",
    domain: "financials",
    cadenceSeconds: 21600,
    basePriority: 13,
    streamIndex: 13,
    defaultWorkClass: "maintenance",
    queueDelayThresholdMs: 90 * 60_000,
    progressStallThresholdMs: 30 * 60_000,
    freshnessSlaSeconds: null,
  },
  // WP-F2: the notification poll. LIVE class at 1 800 s — 48 polls a day, and
  // the cadence is the ONLY thing standing between us and permanent loss: the
  // provider serves each liker/reply/quote once. `domain: "audience"` labels
  // what the lane is about (who interacted with the page) and nothing more —
  // like `stats_snapshot`, it is deliberately ABSENT from SYNC_DOMAIN_POLICY's
  // primary/supporting lists, so a flag-gated lane cannot degrade a page's
  // block-health UX to "catching up" while its gate is shut.
  //
  // basePriority 12 puts it BELOW transactions and the DM lanes on purpose:
  // the notification poll is 1–2 calls and can always wait for money and
  // messages, and the plan's own pacing rule is "priority yield to DM/tx".
  notifications: {
    stream: "notifications",
    domain: "audience",
    cadenceSeconds: 1800,
    basePriority: 12,
    streamIndex: 14,
    defaultWorkClass: "live",
    queueDelayThresholdMs: 30 * 60_000,
    progressStallThresholdMs: 30 * 60_000,
    freshnessSlaSeconds: null,
  },
  // WP-F3: the catalog sweep. MAINTENANCE class at 86 400 s — inventory moves
  // in days, and every step here is deferrable by construction (nothing in this
  // lane is announced once). `domain: "financials"` is where its subscription
  // tiers, plan prices and gift codes belong — there is no `content` domain and
  // inventing one would be a vocabulary change for a label. Like
  // `stats_snapshot` and `notifications` it is deliberately ABSENT from
  // SYNC_DOMAIN_POLICY's primary/supporting lists, so a flag-gated lane cannot
  // degrade a page's block-health UX to "catching up" while its gate is shut.
  //
  // basePriority 11 puts it below the notification poll and far below money and
  // DMs: a daily inventory read can always wait, and the plan's pacing rule is
  // "priority yield to DM/tx".
  catalog: {
    stream: "catalog",
    domain: "financials",
    cadenceSeconds: 86_400,
    basePriority: 11,
    streamIndex: 15,
    defaultWorkClass: "maintenance",
    queueDelayThresholdMs: 6 * 60 * 60_000,
    progressStallThresholdMs: 60 * 60_000,
    freshnessSlaSeconds: null,
  },
  // WP-F5: the replies walk. HISTORY class at 21 600 s — four dispatches a day,
  // each spending a slice of a 100-call daily budget over a back-catalogue that
  // takes ~14 days to first-pass on the biggest live page. `domain: "audience"`
  // is where a comment belongs (it is a fan speaking, not money and not a DM);
  // like every other gated lane it is deliberately ABSENT from
  // SYNC_DOMAIN_POLICY's primary/supporting lists, so a shut gate cannot
  // degrade a page's block-health UX to "catching up".
  //
  // basePriority 10 puts it below the catalog sweep and far below money and
  // DMs: a comment archive that is 14 days from its first pass can always wait
  // one more dispatch, and the plan's pacing rule is "priority yield to DM/tx".
  post_replies: {
    stream: "post_replies",
    domain: "audience",
    cadenceSeconds: 21_600,
    basePriority: 10,
    streamIndex: 16,
    defaultWorkClass: "maintenance",
    queueDelayThresholdMs: 6 * 60 * 60_000,
    progressStallThresholdMs: 60 * 60_000,
    freshnessSlaSeconds: null,
  },
  // WP-F7: the payouts lane. MAINTENANCE class at 86 400 s — a payout request
  // moves in days, and the steady state is exactly two calls: one method
  // listing and one head page. `domain: "financials"` is where money-out
  // belongs; like every other gated lane it is deliberately ABSENT from
  // SYNC_DOMAIN_POLICY's primary/supporting lists, so a shut gate cannot
  // degrade a page's block-health UX to "catching up".
  //
  // basePriority 9 puts it below the comment archive and far below money-IN and
  // DMs. That is not a judgement about how important payouts are — it is that
  // this lane reads a HISTORY nobody is waiting on, two calls at a time, and
  // the plan's pacing rule is "priority yield to DM/tx".
  payouts: {
    stream: "payouts",
    domain: "financials",
    cadenceSeconds: 86_400,
    basePriority: 9,
    streamIndex: 17,
    defaultWorkClass: "maintenance",
    queueDelayThresholdMs: 6 * 60 * 60_000,
    progressStallThresholdMs: 60 * 60_000,
    freshnessSlaSeconds: null,
  },
  // WP-F4: the per-media statistics lane. HISTORY class at 21 600 s — four
  // dispatches a day, each spending a slice of a 300-attempt daily budget over
  // a catalogue of thousands of media. It is the ONE lane in this initiative
  // built to saturate its own cap (A16: at M = 2 000 the decay wants 294
  // calls/day against a cap of 300), so it is never "fresh", never urgent, and
  // what it must not do is burst.
  //
  // `domain: "audience"` is where per-media traffic belongs as a LABEL — it is
  // viewers, not money and not a DM — and like every other gated lane it is
  // deliberately ABSENT from SYNC_DOMAIN_POLICY's primary/supporting lists, so
  // a shut gate cannot degrade a page's block-health UX to "catching up".
  //
  // basePriority 8 is the LOWEST in the tree, below the payouts lane: this is
  // the highest-volume lane in the initiative, it reads a back catalogue nobody
  // is waiting on, and the plan's pacing rule is "priority yield to DM/tx".
  media_stats: {
    stream: "media_stats",
    domain: "audience",
    cadenceSeconds: 21_600,
    basePriority: 8,
    streamIndex: 18,
    defaultWorkClass: "maintenance",
    queueDelayThresholdMs: 6 * 60 * 60_000,
    progressStallThresholdMs: 60 * 60_000,
    freshnessSlaSeconds: null,
  },
};

export const SYNC_DOMAIN_POLICY: Record<SyncDomain, SyncDomainPolicy> = {
  connection: {
    domain: "connection",
    primaryStreams: ["light"],
    supportingStreams: [],
    freshnessSlaSeconds: 3 * 3600,
  },
  financials: {
    domain: "financials",
    primaryStreams: ["transactions"],
    supportingStreams: ["fan_identities", "top_spenders"],
    freshnessSlaSeconds: 3 * 3600,
  },
  audience: {
    domain: "audience",
    primaryStreams: ["subscribers", "followers"],
    supportingStreams: ["followers_reconcile"],
    freshnessSlaSeconds: 3 * 3600,
  },
  messages_live: {
    domain: "messages_live",
    primaryStreams: ["dm_conversations"],
    supportingStreams: [],
    freshnessSlaSeconds: 3600,
  },
  messages_history: {
    domain: "messages_history",
    primaryStreams: ["dm_messages"],
    supportingStreams: [],
    freshnessSlaSeconds: null,
  },
};

export const SYNC_STREAM_DEPENDENCIES: Partial<Record<SyncStream, SyncStream[]>> = {
  // WP-F4: the ONE dependency this initiative declares. `catalog` is what
  // measures M — the media denominator this lane's cadence, its daily demand
  // and its reported cycle estimate are all computed against. Running the
  // per-media walk before the catalogue has been enumerated would size a
  // 300-call-a-day lane against whatever media the DM sidecars happened to
  // mention. (§3.3 site 14: every other new stream declares none.)
  media_stats: ["catalog"],
  top_spenders: ["transactions"],
  purchase_history: ["light"],
  followers_reconcile: ["followers"],
  dm_conversations: ["light", "top_spenders", "transactions", "subscribers", "followers"],
  dm_messages: [
    "light",
    "top_spenders",
    "transactions",
    "subscribers",
    "followers",
    "dm_conversations",
  ],
};

const SYNC_STREAM_PRIORITY_BY_SOURCE: Record<SyncRequestSource, Record<SyncStream, number>> = {
  scheduled: {
    light: 60,
    transactions: 50,
    fan_identities: 49,
    top_spenders: 45,
    subscribers: 40,
    followers: 35,
    followers_reconcile: 34,
    dm_conversations: 30,
    dm_messages: 25,
    fan_earnings: 20,
    purchase_history: 19,
    posts: 18,
    stats_snapshot: 17,
    notifications: 16,
    catalog: 15,
    post_replies: 14,
    payouts: 13,
    media_stats: 12,
  },
  recovery: {
    light: 70,
    transactions: 60,
    fan_identities: 59,
    top_spenders: 55,
    subscribers: 50,
    followers: 45,
    followers_reconcile: 44,
    dm_conversations: 40,
    dm_messages: 35,
    fan_earnings: 30,
    purchase_history: 29,
    posts: 28,
    stats_snapshot: 27,
    notifications: 26,
    catalog: 25,
    post_replies: 24,
    payouts: 23,
    media_stats: 22,
  },
  anomaly: {
    light: 70,
    transactions: 60,
    fan_identities: 59,
    top_spenders: 55,
    subscribers: 50,
    followers: 45,
    followers_reconcile: 44,
    dm_conversations: 40,
    dm_messages: 35,
    fan_earnings: 30,
    purchase_history: 29,
    posts: 28,
    stats_snapshot: 27,
    notifications: 26,
    catalog: 25,
    post_replies: 24,
    payouts: 23,
    media_stats: 22,
  },
  manual: {
    light: 100,
    transactions: 90,
    fan_identities: 89,
    top_spenders: 85,
    subscribers: 80,
    followers: 75,
    followers_reconcile: 74,
    dm_conversations: 70,
    dm_messages: 65,
    fan_earnings: 60,
    purchase_history: 59,
    posts: 58,
    stats_snapshot: 57,
    notifications: 56,
    catalog: 55,
    post_replies: 54,
    payouts: 53,
    media_stats: 52,
  },
  onboarding: {
    light: 100,
    transactions: 90,
    fan_identities: 89,
    top_spenders: 85,
    subscribers: 80,
    followers: 75,
    followers_reconcile: 74,
    dm_conversations: 70,
    dm_messages: 65,
    fan_earnings: 60,
    purchase_history: 59,
    posts: 58,
    stats_snapshot: 57,
    notifications: 56,
    catalog: 55,
    post_replies: 54,
    payouts: 53,
    media_stats: 52,
  },
  reset: {
    light: 100,
    transactions: 90,
    fan_identities: 89,
    top_spenders: 85,
    subscribers: 80,
    followers: 75,
    followers_reconcile: 74,
    dm_conversations: 70,
    dm_messages: 65,
    fan_earnings: 60,
    purchase_history: 59,
    posts: 58,
    stats_snapshot: 57,
    notifications: 56,
    catalog: 55,
    post_replies: 54,
    payouts: 53,
    media_stats: 52,
  },
};

export interface PageSyncState {
  pageId: number;
  stream: SyncStream;
  status: PageSyncStatus;
  requestSeq: number;
  leasedSeq: number | null;
  appliedSeq: number;
  requestSource: SyncRequestSource | null;
  dispatchSource: SyncRequestSource;
  requestPayload: Record<string, unknown>;
  cadenceSeconds: number;
  slotOffsetSeconds: number;
  lastScheduledSlot: number;
  requestedAt: Date | null;
  enqueuedAt: Date | null;
  startedAt: Date | null;
  progressedAt: Date | null;
  finishedAt: Date | null;
  succeededAt: Date | null;
  failedAt: Date | null;
  retryKind: string | null;
  retryAt: Date | null;
  blockerKind: string | null;
  blockerCode: string | null;
  blockerMessage: string | null;
  blockedAt: Date | null;
  phase: string | null;
  workClass: SyncWorkClass | null;
  progress: Record<string, unknown>;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseHeartbeatAt: Date | null;
  leaseExpiresAt: Date | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PageSyncLease extends PageSyncState {
  platform: "fansly" | "onlyfans";
  proxyUrl: string | null;
  egressKey: string;
}

export interface PageSyncWakeupRow {
  pageId: number;
  platform: "fansly" | "onlyfans";
  priority: number;
  requestedAt: Date | null;
  proxyUrl: string | null;
  egressKey: string;
}

function normalizeNumber(value: NumericValue, field: string) {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${field} to be present`);
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "number") {
    return value;
  }

  throw new Error(`Expected ${field} to be numeric`);
}

function normalizeNullableNumber(value: NumericValue, field: string) {
  if (value === null || value === undefined) {
    return null;
  }

  return normalizeNumber(value, field);
}

function normalizeTimestamp(value: TimestampValue, field: string) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Expected ${field} to be a valid timestamp`);
  }

  return parsed;
}

function normalizeRecord(value: unknown, field: string) {
  if (value === null || value === undefined) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${field} to be an object`);
  }

  return value as Record<string, unknown>;
}

function asSyncStream(value: string): SyncStream {
  if ((SYNC_STREAMS as readonly string[]).includes(value)) {
    return value as SyncStream;
  }

  throw new Error(`Unsupported sync stream "${value}"`);
}

function asPlatform(value: unknown, field: string) {
  if (value === "fansly" || value === "onlyfans") {
    return value;
  }

  throw new Error(`Expected ${field} to be a supported platform`);
}

function streamArraySql(streams: readonly SyncStream[]) {
  if (streams.length === 0) {
    return sql`ARRAY[]::sync_stream[]`;
  }

  return sql`ARRAY[${sql.join(streams.map((stream) => sql`${stream}::sync_stream`), sql`, `)}]::sync_stream[]`;
}

function streamOrderSql(columnName: string) {
  return sql.raw(`
    case ${columnName}
      when 'light' then ${SYNC_STREAM_POLICY.light.streamIndex}
      when 'transactions' then ${SYNC_STREAM_POLICY.transactions.streamIndex}
      when 'fan_identities' then ${SYNC_STREAM_POLICY.fan_identities.streamIndex}
      when 'top_spenders' then ${SYNC_STREAM_POLICY.top_spenders.streamIndex}
      when 'subscribers' then ${SYNC_STREAM_POLICY.subscribers.streamIndex}
      when 'followers' then ${SYNC_STREAM_POLICY.followers.streamIndex}
      when 'followers_reconcile' then ${SYNC_STREAM_POLICY.followers_reconcile.streamIndex}
      when 'dm_conversations' then ${SYNC_STREAM_POLICY.dm_conversations.streamIndex}
      when 'dm_messages' then ${SYNC_STREAM_POLICY.dm_messages.streamIndex}
      when 'fan_earnings' then ${SYNC_STREAM_POLICY.fan_earnings.streamIndex}
      when 'purchase_history' then ${SYNC_STREAM_POLICY.purchase_history.streamIndex}
      when 'posts' then ${SYNC_STREAM_POLICY.posts.streamIndex}
      when 'stats_snapshot' then ${SYNC_STREAM_POLICY.stats_snapshot.streamIndex}
      when 'notifications' then ${SYNC_STREAM_POLICY.notifications.streamIndex}
      when 'catalog' then ${SYNC_STREAM_POLICY.catalog.streamIndex}
      when 'post_replies' then ${SYNC_STREAM_POLICY.post_replies.streamIndex}
      when 'payouts' then ${SYNC_STREAM_POLICY.payouts.streamIndex}
      when 'media_stats' then ${SYNC_STREAM_POLICY.media_stats.streamIndex}
      else 999
    end
  `);
}

function streamPriorityBySourceSql(streamColumnName: string, sourceColumnName: string) {
  const priorityCase = (source: SyncRequestSource) => `
    case ${streamColumnName}
      when 'light' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].light}
      when 'transactions' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].transactions}
      when 'fan_identities' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].fan_identities}
      when 'top_spenders' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].top_spenders}
      when 'subscribers' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].subscribers}
      when 'followers' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].followers}
      when 'followers_reconcile' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].followers_reconcile}
      when 'dm_conversations' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].dm_conversations}
      when 'dm_messages' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].dm_messages}
      when 'fan_earnings' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].fan_earnings}
      when 'purchase_history' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].purchase_history}
      when 'posts' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].posts}
      when 'stats_snapshot' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].stats_snapshot}
      when 'notifications' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].notifications}
      when 'catalog' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].catalog}
      when 'post_replies' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].post_replies}
      when 'payouts' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].payouts}
      when 'media_stats' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source].media_stats}
      else 0
    end
  `;

  return sql.raw(`
    case coalesce(${sourceColumnName}, 'scheduled')
      when 'scheduled' then ${priorityCase("scheduled")}
      when 'manual' then ${priorityCase("manual")}
      when 'onboarding' then ${priorityCase("onboarding")}
      when 'recovery' then ${priorityCase("recovery")}
      when 'anomaly' then ${priorityCase("anomaly")}
      when 'reset' then ${priorityCase("reset")}
      else ${priorityCase("scheduled")}
    end
  `);
}

function normalizePageSyncState(row: Record<string, unknown>): PageSyncState {
  const rawStatus = typeof row.status === "string" ? row.status : null;
  if (
    rawStatus !== "idle" &&
    rawStatus !== "pending" &&
    rawStatus !== "running" &&
    rawStatus !== "retrying" &&
    rawStatus !== "blocked" &&
    rawStatus !== "paused"
  ) {
    throw new Error(`Expected status to be a supported page sync status, got ${String(row.status)}`);
  }

  return {
    pageId: normalizeNumber(row.pageId as NumericValue, "pageId"),
    stream: asSyncStream(String(row.stream ?? "")),
    status: rawStatus,
    requestSeq: normalizeNumber(row.requestSeq as NumericValue, "requestSeq"),
    leasedSeq: normalizeNullableNumber(row.leasedSeq as NumericValue, "leasedSeq"),
    appliedSeq: normalizeNumber(row.appliedSeq as NumericValue, "appliedSeq"),
    requestSource: typeof row.requestSource === "string"
      ? row.requestSource as SyncRequestSource
      : null,
    dispatchSource: typeof row.dispatchSource === "string"
      ? row.dispatchSource as SyncRequestSource
      : "scheduled",
    requestPayload: normalizeRecord(row.requestPayload, "requestPayload"),
    cadenceSeconds: normalizeNumber(row.cadenceSeconds as NumericValue, "cadenceSeconds"),
    slotOffsetSeconds: normalizeNumber(row.slotOffsetSeconds as NumericValue, "slotOffsetSeconds"),
    lastScheduledSlot: normalizeNumber(row.lastScheduledSlot as NumericValue, "lastScheduledSlot"),
    requestedAt: normalizeTimestamp(row.requestedAt as TimestampValue, "requestedAt"),
    enqueuedAt: normalizeTimestamp(row.enqueuedAt as TimestampValue, "enqueuedAt"),
    startedAt: normalizeTimestamp(row.startedAt as TimestampValue, "startedAt"),
    progressedAt: normalizeTimestamp(row.progressedAt as TimestampValue, "progressedAt"),
    finishedAt: normalizeTimestamp(row.finishedAt as TimestampValue, "finishedAt"),
    succeededAt: normalizeTimestamp(row.succeededAt as TimestampValue, "succeededAt"),
    failedAt: normalizeTimestamp(row.failedAt as TimestampValue, "failedAt"),
    retryKind: typeof row.retryKind === "string" ? row.retryKind : null,
    retryAt: normalizeTimestamp(row.retryAt as TimestampValue, "retryAt"),
    blockerKind: typeof row.blockerKind === "string" ? row.blockerKind : null,
    blockerCode: typeof row.blockerCode === "string" ? row.blockerCode : null,
    blockerMessage: typeof row.blockerMessage === "string" ? row.blockerMessage : null,
    blockedAt: normalizeTimestamp(row.blockedAt as TimestampValue, "blockedAt"),
    phase: typeof row.phase === "string" ? row.phase : null,
    workClass: typeof row.workClass === "string" ? row.workClass as SyncWorkClass : null,
    progress: normalizeRecord(row.progress, "progress"),
    leaseOwner: typeof row.leaseOwner === "string" ? row.leaseOwner : null,
    leaseToken: typeof row.leaseToken === "string" ? row.leaseToken : null,
    leaseHeartbeatAt: normalizeTimestamp(row.leaseHeartbeatAt as TimestampValue, "leaseHeartbeatAt"),
    leaseExpiresAt: normalizeTimestamp(row.leaseExpiresAt as TimestampValue, "leaseExpiresAt"),
    consecutiveFailures: normalizeNumber(row.consecutiveFailures as NumericValue, "consecutiveFailures"),
    lastErrorCode: typeof row.lastErrorCode === "string" ? row.lastErrorCode : null,
    lastErrorSummary: typeof row.lastErrorSummary === "string" ? row.lastErrorSummary : null,
    createdAt: normalizeTimestamp(row.createdAt as TimestampValue, "createdAt") ?? new Date(0),
    updatedAt: normalizeTimestamp(row.updatedAt as TimestampValue, "updatedAt") ?? new Date(0),
  };
}

function normalizePageSyncLease(row: Record<string, unknown>): PageSyncLease {
  return {
    ...normalizePageSyncState(row),
    platform: asPlatform(row.platform, "platform"),
    proxyUrl: typeof row.proxyUrl === "string" ? row.proxyUrl : null,
    egressKey: typeof row.egressKey === "string" ? row.egressKey : "direct",
  };
}

export function getSyncStreamsForPlatform(platform: "fansly" | "onlyfans"): SyncStream[] {
  // OnlyFans: subscribers is the OFAPI audience sweep (docs/ofapi-parity-plan.md
  // Phase 3) and top_spenders is computed from the transactions table (Phase 5);
  // the planner force-pauses both for pages outside their flags, mirroring the
  // DM-polling gate.
  return platform === "fansly"
    ? SYNC_STREAMS.filter((stream) => stream !== "fan_identities")
    : [
      "light",
      "transactions",
      "fan_identities",
      "top_spenders",
      "subscribers",
      "dm_conversations",
      "posts",
    ];
}

export const ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND = "retired";
export const ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_CODE =
  "legacy_ofapi_dm_messages_retired";
export const ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_MESSAGE =
  "Legacy OnlyFans dm_messages crawler is permanently retired; history acquisition is owned by durable OF mirror jobs";

/**
 * Permanently parks any pre-existing OnlyFans dm_messages state row.
 *
 * New OnlyFans pages no longer receive this stream through
 * getSyncStreamsForPlatform(), but old rows remain durable. This repair is
 * deliberately idempotent and clears every lease field so neither the normal
 * scheduler nor an expired-lease reclaimer can resurrect the retired lane.
 */
export async function retireLegacyOnlyFansDmMessages(
  db: Database,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const inserted = await database.execute(sql`
      insert into ${pageSyncStates} (
        page_id,
        stream,
        status,
        cadence_seconds,
        slot_offset_seconds,
        blocker_kind,
        blocker_code,
        blocker_message,
        blocked_at,
        created_at,
        updated_at
      )
      select p.id,
             'dm_messages',
             'paused',
             ${SYNC_STREAM_POLICY.dm_messages.cadenceSeconds},
             mod(
               (p.id::bigint * 2654435761::bigint) +
                 (${SYNC_STREAM_POLICY.dm_messages.streamIndex}::bigint * 2246822519::bigint),
               ${SYNC_STREAM_POLICY.dm_messages.cadenceSeconds}::bigint
             )::int,
             ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND},
             ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_CODE},
             ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_MESSAGE},
             ${now},
             ${now},
             ${now}
      from ${pages} p
      where p.platform = 'onlyfans'
        and p.status = 'active'
      on conflict (page_id, stream) do nothing
    `);

    const updated = await database.execute(sql`
      update ${pageSyncStates} st
      set status = 'paused',
          blocker_kind = ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND},
          blocker_code = ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_CODE},
          blocker_message = ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_MESSAGE},
          blocked_at = coalesce(st.blocked_at, ${now}),
          leased_seq = null,
          lease_owner = null,
          lease_token = null,
          lease_heartbeat_at = null,
          lease_expires_at = null,
          retry_kind = null,
          retry_at = null,
          updated_at = ${now}
      from ${pages} p
      where p.id = st.page_id
        and p.platform = 'onlyfans'
        and st.stream = 'dm_messages'
        and (
          st.status <> 'paused'
          or st.blocker_kind is distinct from ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND}
          or st.blocker_code is distinct from ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_CODE}
          or st.blocker_message is distinct from ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_MESSAGE}
          or st.leased_seq is not null
          or st.lease_owner is not null
          or st.lease_token is not null
          or st.lease_heartbeat_at is not null
          or st.lease_expires_at is not null
          or st.retry_kind is not null
          or st.retry_at is not null
        )
    `);

    return (inserted.rowCount ?? 0) + (updated.rowCount ?? 0);
  });
}

export function resolvePageSyncPriority(stream: SyncStream, source: SyncRequestSource) {
  return SYNC_STREAM_PRIORITY_BY_SOURCE[source][stream];
}

export function computePageSyncSlotOffsetSeconds(
  pageId: number,
  stream: SyncStream,
) {
  const policy = SYNC_STREAM_POLICY[stream];
  return Number(
    ((BigInt(pageId) * 2654435761n) + (BigInt(policy.streamIndex) * 2246822519n)) %
      BigInt(policy.cadenceSeconds),
  );
}

export function computeCurrentPageSyncSlot(
  now: Date,
  cadenceSeconds: number,
  slotOffsetSeconds: number,
) {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return Math.max(-1, Math.floor((nowSeconds - slotOffsetSeconds) / cadenceSeconds));
}

export function normalizePageSyncRequestStreams(streams: readonly SyncStream[]) {
  return [...new Set(streams)].sort((left, right) =>
    SYNC_STREAM_POLICY[left].streamIndex - SYNC_STREAM_POLICY[right].streamIndex);
}

function computeTrustedStreamTimestamp(
  stream: SyncStream,
  page: {
    lastLightSyncAt: Date | null;
    lastFollowerSyncAt: Date | null;
  },
) {
  if (stream === "light") {
    return page.lastLightSyncAt;
  }

  if (stream === "followers" || stream === "followers_reconcile") {
    return page.lastFollowerSyncAt;
  }

  return null;
}

function buildSeedPageSyncState(
  page: {
    id: number;
    platform: "fansly" | "onlyfans";
    lastLightSyncAt: Date | null;
    lastFollowerSyncAt: Date | null;
    followerCount: number;
    activeFollowerCount: number;
  },
  stream: SyncStream,
  now: Date,
  onboarding: boolean,
): typeof pageSyncStates.$inferInsert {
  const policy = SYNC_STREAM_POLICY[stream];
  const slotOffsetSeconds = computePageSyncSlotOffsetSeconds(page.id, stream);
  const currentSlot = computeCurrentPageSyncSlot(now, policy.cadenceSeconds, slotOffsetSeconds);
  const trustedAt = computeTrustedStreamTimestamp(stream, page);
  const followersReconcileNeedsRecovery = page.platform === "fansly" && (
    page.lastFollowerSyncAt === null ||
    (now.getTime() - page.lastFollowerSyncAt.getTime()) >
      SYNC_STREAM_POLICY.followers_reconcile.cadenceSeconds * 1000 ||
    page.followerCount !== page.activeFollowerCount
  );
  const shouldRecover = onboarding
    ? stream !== "followers_reconcile"
    : stream === "followers_reconcile"
      ? followersReconcileNeedsRecovery
      : trustedAt === null;
  const requestSource: SyncRequestSource | null = shouldRecover
    ? (onboarding ? "onboarding" : "recovery")
    : null;

  if (isSeedPausedSyncStream(stream)) {
    return {
      pageId: page.id,
      stream,
      status: "paused",
      requestSeq: 0,
      appliedSeq: 0,
      requestSource: null,
      dispatchSource: "scheduled",
      requestPayload: {},
      requestedAt: null,
      finishedAt: null,
      succeededAt: null,
      cadenceSeconds: policy.cadenceSeconds,
      slotOffsetSeconds,
      lastScheduledSlot: currentSlot,
      blockerKind: null,
      blockerCode: null,
      blockerMessage: null,
      blockedAt: null,
      workClass: policy.defaultWorkClass,
      progress: {},
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  return {
    pageId: page.id,
    stream,
    status: shouldRecover ? "pending" : "idle",
    requestSeq: shouldRecover ? 1 : 0,
    appliedSeq: 0,
    requestSource,
    dispatchSource: requestSource ?? "scheduled",
    requestPayload: {},
    requestedAt: shouldRecover ? now : null,
    finishedAt: shouldRecover ? null : trustedAt,
    succeededAt: shouldRecover ? null : trustedAt,
    cadenceSeconds: policy.cadenceSeconds,
    slotOffsetSeconds,
    lastScheduledSlot: currentSlot,
    workClass: policy.defaultWorkClass,
    progress: {},
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function listPageSyncStatesInternal(
  db: Database,
  input?: {
    pageId?: number;
    streams?: SyncStream[];
  },
  options?: {
    lock?: boolean;
    expiredLeaseOnly?: boolean;
  },
) {
  const clauses = [sql`true`];

  if (input?.pageId !== undefined) {
    clauses.push(sql`page_id = ${input.pageId}`);
  }

  if (input?.streams?.length) {
    clauses.push(sql`stream = any(${streamArraySql(input.streams)})`);
  }

  if (options?.expiredLeaseOnly) {
    clauses.push(sql`
      leased_seq is not null
      and lease_token is not null
      and lease_expires_at <= clock_timestamp()
    `);
  }

  const result = await db.execute<Record<string, unknown>>(sql`
    select page_id as "pageId",
           stream as "stream",
           status as "status",
           request_seq as "requestSeq",
           leased_seq as "leasedSeq",
           applied_seq as "appliedSeq",
           request_source as "requestSource",
           dispatch_source as "dispatchSource",
           request_payload as "requestPayload",
           cadence_seconds as "cadenceSeconds",
           slot_offset_seconds as "slotOffsetSeconds",
           last_scheduled_slot as "lastScheduledSlot",
           requested_at as "requestedAt",
           enqueued_at as "enqueuedAt",
           started_at as "startedAt",
           progressed_at as "progressedAt",
           finished_at as "finishedAt",
           succeeded_at as "succeededAt",
           failed_at as "failedAt",
           retry_kind as "retryKind",
           retry_at as "retryAt",
           blocker_kind as "blockerKind",
           blocker_code as "blockerCode",
           blocker_message as "blockerMessage",
           blocked_at as "blockedAt",
           phase as "phase",
           work_class as "workClass",
           progress as "progress",
           lease_owner as "leaseOwner",
           lease_token as "leaseToken",
           lease_heartbeat_at as "leaseHeartbeatAt",
           lease_expires_at as "leaseExpiresAt",
           consecutive_failures as "consecutiveFailures",
           last_error_code as "lastErrorCode",
           last_error_summary as "lastErrorSummary",
           created_at as "createdAt",
           updated_at as "updatedAt"
    from ${pageSyncStates}
    where ${and(...clauses)}
    order by page_id asc, ${streamOrderSql("stream")} asc
    ${options?.lock ? sql`for update` : sql``}
  `);

  return result.rows.map((row) => normalizePageSyncState(row));
}

export async function listPageSyncStates(
  db: Database,
  input?: {
    pageId?: number;
    streams?: SyncStream[];
  },
) {
  return listPageSyncStatesInternal(db, input);
}

export async function getPageSyncState(
  db: Database,
  pageId: number,
  stream: SyncStream,
) {
  const rows = await listPageSyncStates(db, {
    pageId,
    streams: [stream],
  });

  return rows[0] ?? null;
}

/**
 * Reconciles one durable Fansly bulk-stream state with its live rollout gate.
 *
 * The feature-gate blocker is ownership metadata: only rows carrying this
 * marker (plus the narrow legacy skipped-success shape) may be auto-resumed.
 * A row lock makes gate flips and the recovery-generation request atomic.
 */
export async function reconcileFanslyBulkStreamGate(
  db: Database,
  input: {
    pageId: number;
    stream: FanslyBulkSyncStream;
    gateState: FanslyBulkStreamGateState;
    now?: Date;
  },
): Promise<FanslyBulkStreamGateReconcileResult> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const [current] = await listPageSyncStatesInternal(database, {
      pageId: input.pageId,
      streams: [input.stream],
    }, { lock: true });

    if (!current) {
      return {
        action: "unchanged",
        createdRecoveryGeneration: false,
      };
    }

    /**
     * The seed shape of a SEED_PAUSED_SYNC_STREAMS lane (see
     * buildSeedPageSyncState): planted `paused` with NO blocker, so the gate's
     * own ownership marker is absent on exactly the rows a gate flip must
     * open. Without this the promise in that comment — "the gate reconciler
     * resumes it" — is false and the flag moves nothing (#191/#194).
     *
     * The test is NEVER RAN, not never requested. `request_seq` is no
     * discriminator: the #192 config wake-up calls requestPageSync on the
     * flag PATCH, which bumps request_seq (and stamps request_source
     * 'recovery') while deliberately leaving a paused row paused — so by the
     * time the planner's reconciler sees a seed row, it usually already
     * carries request_seq >= 1. Verified on production 2026-08-22.
     *
     * What a run leaves behind instead: acquirePageSyncLease stamps
     * `started_at` and `leased_seq`, and applying a generation advances
     * `applied_seq`. None of the three is cleared by pausePageSync,
     * pausePageSyncForAuth or resetPageSync, so a row an operator paused
     * after it ran (or after a failed run, or while a lease was outstanding)
     * can never be mistaken for a seed row.
     */
    const seedPaused =
      current.status === "paused" &&
      current.blockerKind === null &&
      current.appliedSeq === 0 &&
      current.leasedSeq === null &&
      current.startedAt === null;

    if (input.gateState !== "ramped") {
      if (current.status === "running") {
        return {
          action: "unchanged",
          createdRecoveryGeneration: false,
        };
      }

      const featureGateOwned =
        current.blockerKind === FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND;
      const unblockedSchedulable =
        current.blockerKind === null &&
        (
          current.status === "idle" ||
          current.status === "pending" ||
          current.status === "retrying"
        );
      const dependencyBlocked =
        current.status === "blocked" && current.blockerKind === "dependency";

      // Paused/auth/manual/other blocked rows are owned by their respective
      // operators and must not be relabelled as feature-gated. A never-ran
      // seed pause is the gate's own: it is labelled here so the ramped
      // branch can recognize it later through the ordinary marker.
      if (!featureGateOwned && !unblockedSchedulable && !dependencyBlocked && !seedPaused) {
        return {
          action: "unchanged",
          createdRecoveryGeneration: false,
        };
      }

      const blockerMessage = input.gateState === "flag_off"
        ? `${input.stream} is disabled by the Fansly bulk-stream feature flag`
        : `${input.stream} is outside the Fansly bulk-stream rollout allowlist`;
      const alreadyReconciled =
        current.status === "paused" &&
        featureGateOwned &&
        current.blockerCode === input.gateState &&
        current.blockerMessage === blockerMessage &&
        current.blockedAt !== null;

      if (alreadyReconciled) {
        return {
          action: "unchanged",
          createdRecoveryGeneration: false,
        };
      }

      await database.execute(sql`
        update ${pageSyncStates}
        set status = 'paused'::page_sync_status,
            blocker_kind = ${FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND},
            blocker_code = ${input.gateState},
            blocker_message = ${blockerMessage},
            blocked_at = case
                           when blocker_kind = ${FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND}
                             then coalesce(blocked_at, ${now})
                           else ${now}
                         end,
            leased_seq = null,
            lease_owner = null,
            lease_token = null,
            lease_heartbeat_at = null,
            lease_expires_at = null,
            updated_at = ${now}
        where page_id = ${input.pageId}
          and stream = ${input.stream}
      `);

      return {
        action: "paused",
        createdRecoveryGeneration: false,
      };
    }

    if (current.status === "running") {
      return {
        action: "unchanged",
        createdRecoveryGeneration: false,
      };
    }

    const featureGateOwned =
      current.blockerKind === FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND;
    const legacySkipReason = current.progress.skipped;
    const legacySkippedSuccess =
      current.status === "idle" &&
      current.blockerKind === null &&
      (legacySkipReason === "flag_off" || legacySkipReason === "not_allowlisted");

    if (!featureGateOwned && !legacySkippedSuccess && !seedPaused) {
      return {
        action: "unchanged",
        createdRecoveryGeneration: false,
      };
    }

    if (current.requestSeq < current.appliedSeq) {
      throw new Error(
        `Invalid generation state for ${input.stream} on page ${input.pageId}: ` +
          `request_seq ${current.requestSeq} is behind applied_seq ${current.appliedSeq}`,
      );
    }

    const createdRecoveryGeneration = current.requestSeq === current.appliedSeq;
    const nextRequestSeq = createdRecoveryGeneration
      ? current.requestSeq + 1
      : current.requestSeq;
    const retryBackoffActive =
      current.retryAt !== null && current.retryAt.getTime() > now.getTime();
    const nextStatus: PageSyncStatus = retryBackoffActive ? "retrying" : "pending";

    if (createdRecoveryGeneration) {
      const currentSlot = computeCurrentPageSyncSlot(
        now,
        current.cadenceSeconds,
        current.slotOffsetSeconds,
      );
      await database.execute(sql`
        update ${pageSyncStates}
        set status = ${nextStatus}::page_sync_status,
            request_seq = ${nextRequestSeq},
            request_source = 'recovery'::sync_request_source,
            dispatch_source = 'recovery'::sync_request_source,
            request_payload = '{}'::jsonb,
            requested_at = ${now},
            enqueued_at = null,
            last_scheduled_slot = ${currentSlot},
            blocker_kind = null,
            blocker_code = null,
            blocker_message = null,
            blocked_at = null,
            progress = coalesce(progress, '{}'::jsonb) - 'skipped',
            updated_at = ${now}
        where page_id = ${input.pageId}
          and stream = ${input.stream}
      `);
    } else {
      await database.execute(sql`
        update ${pageSyncStates}
        set status = ${nextStatus}::page_sync_status,
            requested_at = ${now},
            enqueued_at = null,
            blocker_kind = null,
            blocker_code = null,
            blocker_message = null,
            blocked_at = null,
            progress = coalesce(progress, '{}'::jsonb) - 'skipped',
            updated_at = ${now}
        where page_id = ${input.pageId}
          and stream = ${input.stream}
      `);
    }

    return {
      action: "resumed",
      createdRecoveryGeneration,
    };
  });
}

async function repairLegacyLightTrustedPageSyncStates(
  db: Database,
  input: {
    pageId?: number;
    now: Date;
  },
) {
  const pageClause = input.pageId === undefined
    ? sql`true`
    : sql`st.page_id = ${input.pageId}`;

  await db.execute(sql`
    update ${pageSyncStates} st
    set status = 'pending'::page_sync_status,
        request_seq = 1,
        request_source = 'recovery'::sync_request_source,
        dispatch_source = 'recovery'::sync_request_source,
        request_payload = '{}'::jsonb,
        requested_at = ${input.now},
        enqueued_at = null,
        started_at = null,
        progressed_at = null,
        finished_at = null,
        succeeded_at = null,
        failed_at = null,
        retry_kind = null,
        retry_at = null,
        blocker_kind = null,
        blocker_code = null,
        blocker_message = null,
        blocked_at = null,
        phase = null,
        progress = '{}'::jsonb,
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        consecutive_failures = 0,
        last_error_code = null,
        last_error_summary = null,
        updated_at = ${input.now}
    from ${pages} p
    where st.page_id = p.id
      and ${pageClause}
      and (
        st.stream = 'transactions'::sync_stream
        or (st.stream = 'subscribers'::sync_stream and p.platform = 'fansly')
      )
      and st.status = 'idle'
      and st.request_seq = 0
      and st.applied_seq = 0
      and st.request_source is null
      and st.requested_at is null
      and st.succeeded_at is not null
  `);
}

export async function ensurePageSyncStates(
  db: Database,
  input?: {
    pageId?: number;
    onboarding?: boolean;
    now?: Date;
    dependencyOptions?: PageSyncDependencyOptions;
  },
) {
  const now = input?.now ?? new Date();
  // Tombstoned pages (deletePageByLabel) must never get sync states seeded
  // or maintained — a deleted page otherwise re-enters the planner forever.
  const clauses = [sql`p.status = 'active'`];
  if (input?.pageId !== undefined) {
    clauses.push(sql`p.id = ${input.pageId}`);
  }

  const pageRows = await db.execute<{
    id: NumericValue;
    platform: unknown;
    lastLightSyncAt: TimestampValue;
    lastFollowerSyncAt: TimestampValue;
    followerCount: NumericValue;
    activeFollowerCount: NumericValue;
  }>(sql`
    select p.id as "id",
           p.platform as "platform",
           p.last_light_sync_at as "lastLightSyncAt",
           p.last_follower_sync_at as "lastFollowerSyncAt",
           p.follower_count as "followerCount",
           coalesce((
             select count(*)::int
             from ${pageFollows} pf
             where pf.platform_account_id = p.id
               and pf.is_active = true
           ), 0)::int as "activeFollowerCount"
    from ${pages} p
    where ${and(...clauses)}
    order by p.id asc
  `);

  if (pageRows.rows.length === 0) {
    return [] as PageSyncState[];
  }

  const normalizedPages: Array<Parameters<typeof buildSeedPageSyncState>[0]> = pageRows.rows.map((row) => ({
    id: normalizeNumber(row.id, "id"),
    platform: asPlatform(row.platform, "platform"),
    lastLightSyncAt: normalizeTimestamp(row.lastLightSyncAt, "lastLightSyncAt"),
    lastFollowerSyncAt: normalizeTimestamp(row.lastFollowerSyncAt, "lastFollowerSyncAt"),
    followerCount: row.followerCount === null || row.followerCount === undefined
      ? 0
      : normalizeNumber(row.followerCount, "followerCount"),
    activeFollowerCount: normalizeNumber(row.activeFollowerCount, "activeFollowerCount"),
  }));

  const existingRows = await listPageSyncStates(
    db,
    input?.pageId !== undefined ? { pageId: input.pageId } : undefined,
  );
  const existingKeys = new Set(existingRows.map((row) => `${row.pageId}:${row.stream}`));
  const values = normalizedPages.flatMap((page) =>
    getSyncStreamsForPlatform(page.platform).flatMap((stream) => {
      const key = `${page.id}:${stream}`;
      if (existingKeys.has(key)) {
        return [];
      }

      return [buildSeedPageSyncState(page, stream, now, input?.onboarding ?? false)];
    })
  );

  if (values.length > 0) {
    await db.insert(pageSyncStates).values(values).onConflictDoNothing();
  }

  await repairLegacyLightTrustedPageSyncStates(db, {
    pageId: input?.pageId,
    now,
  });

  const refreshedRows = await listPageSyncStates(
    db,
    input?.pageId !== undefined ? { pageId: input.pageId } : undefined,
  );

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    for (const row of refreshedRows) {
      const policy = SYNC_STREAM_POLICY[row.stream];
      const slotOffsetSeconds = computePageSyncSlotOffsetSeconds(row.pageId, row.stream);
      if (
        row.cadenceSeconds === policy.cadenceSeconds &&
        row.slotOffsetSeconds === slotOffsetSeconds
      ) {
        continue;
      }

      await database.execute(sql`
        update ${pageSyncStates}
        set cadence_seconds = ${policy.cadenceSeconds},
            slot_offset_seconds = ${slotOffsetSeconds},
            updated_at = ${now}
        where page_id = ${row.pageId}
          and stream = ${row.stream}
      `);
    }
  });

  return listPageSyncStates(
    db,
    input?.pageId !== undefined ? { pageId: input.pageId } : undefined,
  );
}

/**
 * Stream dependencies are a Fansly/legacy ordering concern (hydrate account and
 * audience before DMs). OFAPI-fed OnlyFans DM streams are independent of the
 * legacy light/financial/audience sweeps, but legacy/unmapped OnlyFans pages
 * still need the same ordering guarantees as Fansly.
 */
const ONLYFANS_OFAPI_DM_EXCLUDED_DEPENDENCIES: readonly SyncStream[] = [
  "light",
  "transactions",
  "subscribers",
  "followers",
  "top_spenders",
];

const ONLYFANS_DM_DEPENDENCY_EXEMPT_STREAMS: readonly SyncStream[] = [
  "dm_conversations",
  "dm_messages",
];

export interface PageSyncDependencyOptions {
  onlyFansOfapiDmSyncEnabled?: boolean;
}

interface PageSyncDependencyContext {
  platform: "fansly" | "onlyfans";
  ofapiAccountId: string | null;
}

export function getSyncStreamDependenciesForPlatform(
  platform: "fansly" | "onlyfans",
  stream: SyncStream,
): SyncStream[] {
  return getSyncStreamDependenciesForPage({ platform, stream });
}

export function getSyncStreamDependenciesForPage(input: {
  platform: "fansly" | "onlyfans";
  stream: SyncStream;
  onlyFansOfapiDmEligible?: boolean;
}): SyncStream[] {
  const base = SYNC_STREAM_DEPENDENCIES[input.stream] ?? [];
  if (
    input.platform !== "onlyfans" ||
    input.onlyFansOfapiDmEligible !== true ||
    !ONLYFANS_DM_DEPENDENCY_EXEMPT_STREAMS.includes(input.stream)
  ) {
    return [...base];
  }

  return base.filter((dependency) => !ONLYFANS_OFAPI_DM_EXCLUDED_DEPENDENCIES.includes(dependency));
}

function isOnlyFansOfapiDmDependencyEligible(
  context: PageSyncDependencyContext,
  options?: PageSyncDependencyOptions,
) {
  return options?.onlyFansOfapiDmSyncEnabled === true &&
    context.platform === "onlyfans" &&
    typeof context.ofapiAccountId === "string" &&
    context.ofapiAccountId.length > 0;
}

async function getPageDependencyContexts(
  db: Database,
  pageIds: number[],
): Promise<Map<number, PageSyncDependencyContext>> {
  if (pageIds.length === 0) {
    return new Map();
  }

  const result = await db.execute(sql`
    select id, platform, ofapi_account_id as "ofapiAccountId"
    from pages
    where id in (${sql.join(pageIds.map((id) => sql`${id}`), sql`, `)})
  `);
  const contexts = new Map<number, PageSyncDependencyContext>();
  for (const row of result.rows) {
    const platform = row.platform === "onlyfans" ? "onlyfans" : "fansly";
    contexts.set(Number(row.id), {
      platform,
      ofapiAccountId: typeof row.ofapiAccountId === "string" ? row.ofapiAccountId : null,
    });
  }
  return contexts;
}

function dependencyMet(streamByName: Map<SyncStream, PageSyncState>, dependency: SyncStream) {
  const row = streamByName.get(dependency);
  return Boolean(row && (row.succeededAt !== null || row.appliedSeq > 0));
}

export async function refreshPageSyncDependencies(
  db: Database,
  input?: {
    pageId?: number;
    now?: Date;
    dependencyOptions?: PageSyncDependencyOptions;
  },
) {
  const now = input?.now ?? new Date();
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const rows = await listPageSyncStatesInternal(
      database,
      input?.pageId !== undefined ? { pageId: input.pageId } : undefined,
      { lock: true },
    );
    await refreshLockedPageSyncDependencies(database, rows, now, input?.dependencyOptions);
  });
}

async function refreshLockedPageSyncDependencies(
  db: Database,
  rows: PageSyncState[],
  now: Date,
  options?: PageSyncDependencyOptions,
) {
  const rowsByPage = new Map<number, PageSyncState[]>();
  for (const row of rows) {
    const current = rowsByPage.get(row.pageId) ?? [];
    current.push(row);
    rowsByPage.set(row.pageId, current);
  }

  const contextByPage = await getPageDependencyContexts(db, [...rowsByPage.keys()]);

  for (const [pageId, pageRows] of rowsByPage) {
    const context = contextByPage.get(pageId) ?? { platform: "fansly" as const, ofapiAccountId: null };
    const streamByName = new Map(pageRows.map((row) => [row.stream, row] as const));
    for (const row of pageRows) {
      const dependencies = getSyncStreamDependenciesForPage({
        platform: context.platform,
        stream: row.stream,
        onlyFansOfapiDmEligible: isOnlyFansOfapiDmDependencyEligible(context, options),
      }).filter((dependency) => streamByName.has(dependency));
      if (dependencies.length === 0) {
        if (row.blockerKind !== "dependency" || row.status === "paused") {
          continue;
        }

        const nextStatus: PageSyncStatus = row.requestSeq > row.appliedSeq ? "pending" : "idle";
        await db.execute(sql`
          update ${pageSyncStates}
          set status = ${nextStatus}::page_sync_status,
              blocker_kind = null,
              blocker_code = null,
              blocker_message = null,
              blocked_at = null,
              updated_at = ${now}
          where page_id = ${pageId}
            and stream = ${row.stream}
            and blocker_kind = 'dependency'
            and status <> 'paused'
        `);
        continue;
      }

      const unmet = dependencies.filter((dependency) => !dependencyMet(streamByName, dependency));
      if (unmet.length > 0) {
        const shouldBlock = row.status !== "paused" && row.status !== "running" &&
          (row.requestSeq > row.appliedSeq || row.status === "pending" || row.status === "retrying");
        if (!shouldBlock) {
          continue;
        }

        await db.execute(sql`
          update ${pageSyncStates}
          set status = 'blocked',
              blocker_kind = 'dependency',
              blocker_code = 'unmet_dependency',
              blocker_message = ${`Waiting for ${unmet.join(", ")}`},
              blocked_at = coalesce(blocked_at, ${now}),
              retry_kind = null,
              retry_at = null,
              updated_at = ${now}
          where page_id = ${pageId}
            and stream = ${row.stream}
            and status <> 'paused'
            and status <> 'running'
            and (request_seq > applied_seq or status in ('pending', 'retrying'))
        `);
        continue;
      }

      if (row.blockerKind !== "dependency" || row.status === "paused") {
        continue;
      }

      const nextStatus: PageSyncStatus = row.requestSeq > row.appliedSeq ? "pending" : "idle";
      await db.execute(sql`
        update ${pageSyncStates}
        set status = ${nextStatus}::page_sync_status,
            blocker_kind = null,
            blocker_code = null,
            blocker_message = null,
            blocked_at = null,
            updated_at = ${now}
        where page_id = ${pageId}
          and stream = ${row.stream}
          and blocker_kind = 'dependency'
          and status <> 'paused'
      `);
    }
  }
}

export async function reclaimExpiredPageSync(
  db: Database,
  _legacyProcessNow?: Date,
) {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const reclaimable = await listPageSyncStatesInternal(
      database,
      undefined,
      { expiredLeaseOnly: true, lock: true },
    );
    const reclaimed: PageSyncState[] = [];

    for (const row of reclaimable) {
      const result = await database.execute(sql`
        update ${pageSyncStates}
        set status = case
                       when blocker_kind is not null then 'blocked'::page_sync_status
                       when retry_at is not null and retry_at > clock_timestamp() then 'retrying'::page_sync_status
                       when request_seq > applied_seq then 'pending'::page_sync_status
                       else 'idle'::page_sync_status
                     end,
            leased_seq = null,
            lease_owner = null,
            lease_token = null,
            lease_heartbeat_at = null,
            lease_expires_at = null,
            updated_at = clock_timestamp()
        where page_id = ${row.pageId}
          and stream = ${row.stream}
          and leased_seq = ${row.leasedSeq}
          and lease_token = ${row.leaseToken}
          and lease_expires_at <= clock_timestamp()
      `);

      if ((result.rowCount ?? 0) > 0) {
        reclaimed.push(row);
      }
    }

    return reclaimed;
  });
}

export async function scheduleDuePageSync(
  db: Database,
  input?: {
    pageId?: number;
    now?: Date;
    dependencyOptions?: PageSyncDependencyOptions;
  },
) {
  const now = input?.now ?? new Date();
  await ensurePageSyncStates(db, {
    pageId: input?.pageId,
    now,
    dependencyOptions: input?.dependencyOptions,
  });
  await reclaimExpiredPageSync(db, now);

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const rows = await listPageSyncStatesInternal(
      database,
      input?.pageId !== undefined ? { pageId: input.pageId } : undefined,
      { lock: true },
    );

    for (const row of rows) {
      if (row.status === "paused") {
        continue;
      }

      if (row.status === "blocked" && row.blockerKind !== "dependency") {
        continue;
      }

      // The DB-clock reclaim above is the only lease-expiry authority. A row
      // that remains running here still owns a live lease.
      if (row.status === "running") {
        continue;
      }

      if (row.retryAt && row.retryAt.getTime() > now.getTime()) {
        continue;
      }

      if (row.requestSeq > row.appliedSeq) {
        if (row.status !== "blocked") {
          await database.execute(sql`
            update ${pageSyncStates}
            set status = 'pending',
                retry_kind = null,
                retry_at = null,
                updated_at = ${now}
            where page_id = ${row.pageId}
              and stream = ${row.stream}
              and request_seq = ${row.requestSeq}
              and applied_seq = ${row.appliedSeq}
              and leased_seq is null
          `);
        }
        continue;
      }

      const currentSlot = computeCurrentPageSyncSlot(now, row.cadenceSeconds, row.slotOffsetSeconds);
      if (currentSlot <= row.lastScheduledSlot) {
        continue;
      }

      const nextRequestSeq = row.requestSeq + 1;
      const nextStatus: PageSyncStatus = row.status === "blocked" ? "blocked" : "pending";
      await database.execute(sql`
        update ${pageSyncStates}
        set request_seq = ${nextRequestSeq},
            request_source = 'scheduled',
            dispatch_source = 'scheduled',
            request_payload = '{}'::jsonb,
            requested_at = ${now},
            last_scheduled_slot = ${currentSlot},
            status = ${nextStatus}::page_sync_status,
            updated_at = ${now}
        where page_id = ${row.pageId}
          and stream = ${row.stream}
          and request_seq = ${row.requestSeq}
          and applied_seq = ${row.appliedSeq}
      `);
    }
  });

  await refreshPageSyncDependencies(db, {
    pageId: input?.pageId,
    now,
    dependencyOptions: input?.dependencyOptions,
  });

  return listPageSyncStates(
    db,
    input?.pageId !== undefined ? { pageId: input.pageId } : undefined,
  );
}

export async function listRunnablePageSync(
  db: Database,
  now = new Date(),
) {
  const result = await db.execute<Record<string, unknown>>(sql`
    with runnable_streams as (
      select st.page_id as "pageId",
             p.platform as "platform",
             ee.url as "proxyUrl",
             ${egressKeySql(sql`ee.rate_limit_scope_key`, sql`ee.url`)} as "egressKey",
             st.stream as "stream",
             st.requested_at as "requestedAt",
             st.dispatch_source as "dispatchSource"
      from ${pageSyncStates} st
      inner join ${pages} p on p.id = st.page_id and p.status = 'active'
      left join ${egressEndpoints} ee on ee.platform_account_id = st.page_id
      where st.request_seq > st.applied_seq
        and st.status <> 'paused'
        and st.blocker_kind is null
        and not (p.platform = 'onlyfans' and st.stream = 'dm_messages')
        and st.leased_seq is null
        and (st.retry_at is null or st.retry_at <= ${now})
    )
    select rs."pageId" as "pageId",
           rs."platform" as "platform",
           max(${streamPriorityBySourceSql('rs."stream"', 'rs."dispatchSource"')})::int as "priority",
           min(rs."requestedAt") as "requestedAt",
           rs."proxyUrl" as "proxyUrl",
           rs."egressKey" as "egressKey"
    from runnable_streams rs
    group by rs."pageId", rs."platform", rs."proxyUrl", rs."egressKey"
    order by max(${streamPriorityBySourceSql('rs."stream"', 'rs."dispatchSource"')}) desc,
             min(rs."requestedAt") asc nulls last,
             rs."pageId" asc
  `);

  return result.rows.map((row) => ({
    pageId: normalizeNumber(row.pageId as NumericValue, "pageId"),
    platform: asPlatform(row.platform, "platform"),
    priority: normalizeNumber(row.priority as NumericValue, "priority"),
    requestedAt: normalizeTimestamp(row.requestedAt as TimestampValue, "requestedAt"),
    proxyUrl: typeof row.proxyUrl === "string" ? row.proxyUrl : null,
    egressKey: typeof row.egressKey === "string" ? row.egressKey : "direct",
  })) satisfies PageSyncWakeupRow[];
}

export async function markPageSyncEnqueued(
  db: Database,
  pageId: number,
  now = new Date(),
) {
  await db.execute(sql`
    update ${pageSyncStates}
    set enqueued_at = ${now},
        updated_at = ${now}
    where page_id = ${pageId}
      and request_seq > applied_seq
      and status <> 'paused'
      and blocker_kind is null
      and leased_seq is null
      and (retry_at is null or retry_at <= ${now})
  `);
}

export async function acquirePageSyncLease(
  db: Database,
  input: {
    pageId: number;
    workerId: string;
    leaseToken: string;
    leaseTtlMs: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = await db.execute<Record<string, unknown>>(sql`
    with candidate as (
      select st.page_id as "pageId",
             st.stream as "stream",
             st.request_seq as "requestSeq"
      from ${pageSyncStates} st
      where st.page_id = ${input.pageId}
        and st.request_seq > st.applied_seq
        and st.status <> 'paused'
        and st.blocker_kind is null
        and not exists (
          select 1
          from ${pages} retired_page
          where retired_page.id = st.page_id
            and retired_page.platform = 'onlyfans'
            and st.stream = 'dm_messages'
        )
        and st.leased_seq is null
        and (st.retry_at is null or st.retry_at <= ${now})
        and exists (
          select 1 from ${pages} p
          where p.id = st.page_id and p.status = 'active'
        )
      order by ${streamPriorityBySourceSql("st.stream", "st.dispatch_source")} desc,
               st.requested_at asc nulls last,
               ${streamOrderSql("st.stream")} asc
      limit 1
    ),
    acquired as (
      update ${pageSyncStates} st
      set status = 'running',
          leased_seq = candidate."requestSeq",
          lease_owner = ${input.workerId},
          lease_token = ${input.leaseToken},
          lease_heartbeat_at = clock_timestamp(),
          lease_expires_at = clock_timestamp() + (${input.leaseTtlMs} * interval '1 millisecond'),
          started_at = ${now},
          updated_at = ${now}
      from candidate
      where st.page_id = candidate."pageId"
        and st.stream = candidate."stream"
        and st.request_seq = candidate."requestSeq"
        and st.status <> 'paused'
        and st.blocker_kind is null
        and not exists (
          select 1
          from ${pages} retired_page
          where retired_page.id = st.page_id
            and retired_page.platform = 'onlyfans'
            and st.stream = 'dm_messages'
        )
        and st.leased_seq is null
        and (st.retry_at is null or st.retry_at <= ${now})
      returning st.page_id as "pageId",
                st.stream as "stream",
                st.status as "status",
                st.request_seq as "requestSeq",
                st.leased_seq as "leasedSeq",
                st.applied_seq as "appliedSeq",
                st.request_source as "requestSource",
                st.dispatch_source as "dispatchSource",
                st.request_payload as "requestPayload",
                st.cadence_seconds as "cadenceSeconds",
                st.slot_offset_seconds as "slotOffsetSeconds",
                st.last_scheduled_slot as "lastScheduledSlot",
                st.requested_at as "requestedAt",
                st.enqueued_at as "enqueuedAt",
                st.started_at as "startedAt",
                st.progressed_at as "progressedAt",
                st.finished_at as "finishedAt",
                st.succeeded_at as "succeededAt",
                st.failed_at as "failedAt",
                st.retry_kind as "retryKind",
                st.retry_at as "retryAt",
                st.blocker_kind as "blockerKind",
                st.blocker_code as "blockerCode",
                st.blocker_message as "blockerMessage",
                st.blocked_at as "blockedAt",
                st.phase as "phase",
                st.work_class as "workClass",
                st.progress as "progress",
                st.lease_owner as "leaseOwner",
                st.lease_token as "leaseToken",
                st.lease_heartbeat_at as "leaseHeartbeatAt",
                st.lease_expires_at as "leaseExpiresAt",
                st.consecutive_failures as "consecutiveFailures",
                st.last_error_code as "lastErrorCode",
                st.last_error_summary as "lastErrorSummary",
                st.created_at as "createdAt",
                st.updated_at as "updatedAt"
    )
    select acquired.*,
           p.platform as "platform",
           ee.url as "proxyUrl",
           ${egressKeySql(sql`ee.rate_limit_scope_key`, sql`ee.url`)} as "egressKey"
    from acquired
    inner join ${pages} p on p.id = acquired."pageId"
    left join ${egressEndpoints} ee on ee.platform_account_id = acquired."pageId"
    limit 1
  `);

  return result.rows[0] ? normalizePageSyncLease(result.rows[0]) : null;
}

export interface TargetedPageSyncLease {
  pageId: number;
  stream: SyncStream;
  requestSeq: number;
  leasedSeq: number;
  leaseToken: string;
}

/**
 * Slice C′: take the page's REAL sync lease for ONE named stream so an
 * out-of-band run (today: the targeted thread backfill) fences against the
 * regular executor instead of racing it. Same row, same lease columns, same
 * fence token that `assertOwnedPageSyncLease` verifies — acquire or return
 * null, never run lease-less.
 *
 * Differences from `acquirePageSyncLease`, both deliberate:
 *  - the stream is named by the caller instead of being picked by priority;
 *  - no `request_seq > applied_seq` precondition — an owner-initiated run must
 *    work on an idle stream, and it deliberately does NOT consume a pending
 *    request (`applied_seq` is never advanced here, so a queued scheduled
 *    request survives the run untouched).
 * Everything that guards the regular acquire still guards this one: paused,
 * blocked, retry-backoff, already-leased, and non-active pages all refuse.
 * `started_at` is left alone — this run is not the stream's scheduled chunk.
 */
export async function acquireTargetedPageSyncLease(
  db: Database,
  input: {
    pageId: number;
    stream: SyncStream;
    workerId: string;
    leaseToken: string;
    leaseTtlMs: number;
    now?: Date;
  },
): Promise<TargetedPageSyncLease | null> {
  const now = input.now ?? new Date();
  const result = await db.execute<{
    pageId: NumericValue;
    stream: SyncStream;
    requestSeq: NumericValue;
    leasedSeq: NumericValue;
    leaseToken: string;
  }>(sql`
    update ${pageSyncStates} st
    set status = 'running',
        leased_seq = st.request_seq,
        lease_owner = ${input.workerId},
        lease_token = ${input.leaseToken},
        lease_heartbeat_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + (${input.leaseTtlMs} * interval '1 millisecond'),
        updated_at = ${now}
    where st.page_id = ${input.pageId}
      and st.stream = ${input.stream}
      and st.status <> 'paused'
      and st.blocker_kind is null
      and st.leased_seq is null
      and (st.retry_at is null or st.retry_at <= ${now})
      and exists (
        select 1 from ${pages} p
        where p.id = st.page_id and p.status = 'active'
      )
    returning st.page_id as "pageId",
              st.stream as "stream",
              st.request_seq as "requestSeq",
              st.leased_seq as "leasedSeq",
              st.lease_token as "leaseToken"
  `);

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    pageId: normalizeNumber(row.pageId, "pageId"),
    stream: row.stream,
    requestSeq: normalizeNumber(row.requestSeq, "requestSeq"),
    leasedSeq: normalizeNumber(row.leasedSeq, "leasedSeq"),
    leaseToken: row.leaseToken,
  };
}

/**
 * Release a lease taken by `acquireTargetedPageSyncLease`. The next status is
 * computed from the row itself with the same CASE the expiry reclaimer uses,
 * so a request that arrived DURING the run (requestPageSync keeps a live lease
 * running) leaves the stream `pending` rather than silently idle.
 */
export async function releaseTargetedPageSyncLease(
  db: Database,
  input: {
    pageId: number;
    stream: SyncStream;
    leaseToken: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = await db.execute(sql`
    update ${pageSyncStates}
    set status = case
                   when blocker_kind is not null then 'blocked'::page_sync_status
                   when retry_at is not null and retry_at > clock_timestamp() then 'retrying'::page_sync_status
                   when request_seq > applied_seq then 'pending'::page_sync_status
                   else 'idle'::page_sync_status
                 end,
        leased_seq = null,
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where page_id = ${input.pageId}
      and stream = ${input.stream}
      and lease_token = ${input.leaseToken}
      and leased_seq is not null
      and status = 'running'
  `);

  return (result.rowCount ?? 0) > 0;
}

export async function heartbeatPageSyncLease(
  db: Database,
  input: {
    pageId: number;
    stream: SyncStream;
    leaseToken: string;
    leaseTtlMs: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = await db.execute(sql`
    update ${pageSyncStates}
    set lease_heartbeat_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + (${input.leaseTtlMs} * interval '1 millisecond'),
        updated_at = ${now}
    where page_id = ${input.pageId}
      and stream = ${input.stream}
      and lease_token = ${input.leaseToken}
      and leased_seq is not null
      and status = 'running'
      and lease_expires_at > clock_timestamp()
  `);

  return (result.rowCount ?? 0) > 0;
}

export async function recordRunningPageSyncProgress(
  db: Database,
  input: {
    pageId: number;
    stream: SyncStream;
    requestSeq: number;
    leaseToken: string;
    progressedAt?: Date | null;
    phase?: string | null;
    workClass?: SyncWorkClass | null;
    progress?: Record<string, unknown>;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const progressedAt = input.progressedAt ?? now;
  const result = await db.execute(sql`
    update ${pageSyncStates}
    set progressed_at = ${progressedAt},
        phase = coalesce(${input.phase ?? null}, phase),
        work_class = coalesce(${input.workClass ?? null}, work_class),
        progress = ${input.progress ?? {}},
        updated_at = ${now}
    where page_id = ${input.pageId}
      and stream = ${input.stream}
      and lease_token = ${input.leaseToken}
      and leased_seq = ${input.requestSeq}
      and status = 'running'
      and lease_expires_at > clock_timestamp()
  `);

  return (result.rowCount ?? 0) > 0;
}

export async function clearPageSyncLease(
  db: Database,
  input: {
    pageId: number;
    stream: SyncStream;
    leaseToken: string;
    nextStatus: PageSyncStatus;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = await db.execute(sql`
    update ${pageSyncStates}
    set status = ${input.nextStatus}::page_sync_status,
        leased_seq = null,
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where page_id = ${input.pageId}
      and stream = ${input.stream}
      and lease_token = ${input.leaseToken}
      and leased_seq is not null
      and status = 'running'
      and lease_expires_at > clock_timestamp()
  `);

  return (result.rowCount ?? 0) > 0;
}

export async function completePageSync(
  db: Database,
  input: {
    pageId: number;
    stream: SyncStream;
    requestSeq: number;
    leaseToken: string;
    progressedAt?: Date | null;
    phase?: string | null;
    workClass?: SyncWorkClass | null;
    progress?: Record<string, unknown>;
    now?: Date;
    dependencyOptions?: PageSyncDependencyOptions;
  },
) {
  const now = input.now ?? new Date();
  const result = await db.execute(sql`
    update ${pageSyncStates}
    set status = case
                   when request_seq > ${input.requestSeq} then 'pending'::page_sync_status
                   else 'idle'::page_sync_status
                 end,
        applied_seq = greatest(applied_seq, ${input.requestSeq}),
        leased_seq = null,
        progressed_at = coalesce(${input.progressedAt ?? null}, progressed_at, ${now}),
        finished_at = ${now},
        succeeded_at = ${now},
        retry_kind = null,
        retry_at = null,
        blocker_kind = null,
        blocker_code = null,
        blocker_message = null,
        blocked_at = null,
        phase = ${input.phase ?? null},
        work_class = ${input.workClass ?? null},
        progress = ${input.progress ?? {}},
        consecutive_failures = 0,
        last_error_code = null,
        last_error_summary = null,
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where page_id = ${input.pageId}
      and stream = ${input.stream}
      and lease_token = ${input.leaseToken}
      and leased_seq = ${input.requestSeq}
      and status = 'running'
      and lease_expires_at > clock_timestamp()
  `);

  const applied = (result.rowCount ?? 0) > 0;
  if (applied) {
    await refreshPageSyncDependencies(db, {
      pageId: input.pageId,
      now,
      dependencyOptions: input.dependencyOptions,
    });
  }

  return applied;
}

/** A gated stream chunk that did no work: the ramp gate (platform / flag /
 *  allowlist) short-circuited before any egress. It terminates the lease and
 *  advances applied_seq exactly like a real completion — the scheduler decides
 *  "due" from applied_seq/last_scheduled_slot, never from succeeded_at — but it
 *  must claim NOTHING. A page dropped from the allowlist used to report
 *  succeeded_at = now() forever while its projection stood still, which is how
 *  lora-1 went 13 days unnoticed (2026-07-17 to 2026-07-31).
 *  consecutive_failures and last_error_* are left untouched: a skip is neither
 *  success nor failure, so it must neither clear a real failure streak nor
 *  invent one. progressed_at is left untouched for the same reason — a chunk
 *  that issued zero requests made no progress. */
export async function skipPageSync(
  db: Database,
  input: {
    pageId: number;
    stream: SyncStream;
    requestSeq: number;
    leaseToken: string;
    phase?: string | null;
    workClass?: SyncWorkClass | null;
    progress?: Record<string, unknown>;
    now?: Date;
    dependencyOptions?: PageSyncDependencyOptions;
  },
) {
  const now = input.now ?? new Date();
  const result = await db.execute(sql`
    update ${pageSyncStates}
    set status = case
                   when request_seq > ${input.requestSeq} then 'pending'::page_sync_status
                   else 'idle'::page_sync_status
                 end,
        applied_seq = greatest(applied_seq, ${input.requestSeq}),
        leased_seq = null,
        finished_at = ${now},
        retry_kind = null,
        retry_at = null,
        blocker_kind = null,
        blocker_code = null,
        blocker_message = null,
        blocked_at = null,
        phase = ${input.phase ?? null},
        work_class = ${input.workClass ?? null},
        progress = ${input.progress ?? {}},
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where page_id = ${input.pageId}
      and stream = ${input.stream}
      and lease_token = ${input.leaseToken}
      and leased_seq = ${input.requestSeq}
      and status = 'running'
      and lease_expires_at > clock_timestamp()
  `);

  const applied = (result.rowCount ?? 0) > 0;
  if (applied) {
    // Spread rather than `dependencyOptions: input.dependencyOptions`: under
    // exactOptionalPropertyTypes an explicit `undefined` is not the same as an
    // absent optional, and new code owes the strictness ratchet a clean file.
    await refreshPageSyncDependencies(db, {
      pageId: input.pageId,
      now,
      ...(input.dependencyOptions === undefined ? {} : { dependencyOptions: input.dependencyOptions }),
    });
  }

  return applied;
}

export async function yieldPageSync(
  db: Database,
  input: {
    pageId: number;
    stream: SyncStream;
    requestSeq: number;
    leaseToken: string;
    progressedAt?: Date | null;
    phase?: string | null;
    workClass?: SyncWorkClass | null;
    progress?: Record<string, unknown>;
    retryAt?: Date | null;
    dispatchSource?: SyncRequestSource | null;
    now?: Date;
  },
): Promise<PageSyncYieldResult> {
  const now = input.now ?? new Date();
  const retryAt = input.retryAt ?? null;
  const dispatchSource = input.dispatchSource ?? null;
  const result = await db.execute(sql<{ requestSeq: number }>`
    update ${pageSyncStates}
    set status = 'pending',
        leased_seq = null,
        progressed_at = coalesce(${input.progressedAt ?? null}, progressed_at),
        finished_at = ${now},
        phase = ${input.phase ?? null},
        work_class = ${input.workClass ?? null},
        progress = ${input.progress ?? {}},
        dispatch_source = case
                            when request_seq > ${input.requestSeq} then dispatch_source
                            else coalesce(${dispatchSource}::sync_request_source, dispatch_source)
                          end,
        consecutive_failures = 0,
        last_error_code = null,
        last_error_summary = null,
        retry_kind = null,
        retry_at = case
                     when request_seq > ${input.requestSeq} then null::timestamptz
                     else ${retryAt}
                   end,
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where page_id = ${input.pageId}
      and stream = ${input.stream}
      and lease_token = ${input.leaseToken}
      and leased_seq = ${input.requestSeq}
      and status = 'running'
      and lease_expires_at > clock_timestamp()
    returning request_seq as "requestSeq"
  `);

  const updated = result.rows[0] ?? null;
  const updatedRequestSeq = updated
    ? normalizeNumber(updated.requestSeq as NumericValue, "requestSeq")
    : null;
  return {
    updated: updated !== null,
    superseded: updatedRequestSeq !== null && updatedRequestSeq > input.requestSeq,
  };
}

function resolveRetryDelayMs(consecutiveFailures: number) {
  const seconds = 60 * (2 ** Math.max(0, consecutiveFailures - 1));
  return Math.min(seconds, 30 * 60) * 1000;
}

export async function retryPageSync(
  db: Database,
  input: {
    pageId: number;
    stream: SyncStream;
    requestSeq: number;
    leaseToken: string;
    retryKind: string;
    errorCode: string | null;
    errorSummary: string;
    progressedAt?: Date | null;
    phase?: string | null;
    workClass?: SyncWorkClass | null;
    progress?: Record<string, unknown>;
    now?: Date;
  },
): Promise<PageSyncRetryResult> {
  const now = input.now ?? new Date();
  const row = await getPageSyncState(db, input.pageId, input.stream);
  const nextFailures = (row?.consecutiveFailures ?? 0) + 1;
  const retryAt = new Date(now.getTime() + resolveRetryDelayMs(nextFailures));
  const result = await db.execute(sql<{ status: PageSyncStatus; retryKind: string | null }>`
    update ${pageSyncStates}
    set status = case
                   when request_seq > ${input.requestSeq} then 'pending'::page_sync_status
                   else 'retrying'::page_sync_status
                 end,
        leased_seq = null,
        progressed_at = coalesce(${input.progressedAt ?? null}, progressed_at),
        finished_at = ${now},
        failed_at = case when request_seq > ${input.requestSeq} then failed_at else ${now} end,
        retry_kind = case when request_seq > ${input.requestSeq} then null else ${input.retryKind} end,
        retry_at = case when request_seq > ${input.requestSeq} then null::timestamptz else ${retryAt} end,
        dispatch_source = case
                            when request_seq > ${input.requestSeq} then dispatch_source
                            else 'scheduled'::sync_request_source
                          end,
        blocker_kind = null,
        blocker_code = null,
        blocker_message = null,
        blocked_at = null,
        phase = ${input.phase ?? null},
        work_class = ${input.workClass ?? null},
        progress = ${input.progress ?? {}},
        consecutive_failures = case when request_seq > ${input.requestSeq} then 0 else ${nextFailures} end,
        last_error_code = case when request_seq > ${input.requestSeq} then null else ${input.errorCode} end,
        last_error_summary = case when request_seq > ${input.requestSeq} then null else ${input.errorSummary} end,
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where page_id = ${input.pageId}
      and stream = ${input.stream}
      and lease_token = ${input.leaseToken}
      and leased_seq = ${input.requestSeq}
      and status = 'running'
      and lease_expires_at > clock_timestamp()
    returning status,
              retry_kind as "retryKind"
  `);

  const updated = result.rows[0] ?? null;
  return {
    updated: updated !== null,
    retried: updated?.status === "retrying" && updated.retryKind === input.retryKind,
  };
}

export async function blockPageSync(
  db: Database,
  input: {
    pageId: number;
    stream: SyncStream;
    requestSeq: number;
    leaseToken: string;
    blockerKind: string;
    blockerCode: string;
    blockerMessage: string;
    errorCode: string | null;
    errorSummary: string;
    progressedAt?: Date | null;
    phase?: string | null;
    workClass?: SyncWorkClass | null;
    progress?: Record<string, unknown>;
    now?: Date;
  },
): Promise<PageSyncBlockResult> {
  const now = input.now ?? new Date();
  const row = await getPageSyncState(db, input.pageId, input.stream);
  const nextFailures = (row?.consecutiveFailures ?? 0) + 1;
  const result = await db.execute(sql<{ status: PageSyncStatus; blockerKind: string | null }>`
    update ${pageSyncStates}
    set status = case
                   when request_seq > ${input.requestSeq} then 'pending'::page_sync_status
                   else 'blocked'::page_sync_status
                 end,
        leased_seq = null,
        progressed_at = coalesce(${input.progressedAt ?? null}, progressed_at),
        finished_at = ${now},
        failed_at = case when request_seq > ${input.requestSeq} then failed_at else ${now} end,
        retry_kind = null,
        retry_at = null,
        dispatch_source = case
                            when request_seq > ${input.requestSeq} then dispatch_source
                            else 'scheduled'::sync_request_source
                          end,
        blocker_kind = case when request_seq > ${input.requestSeq} then null else ${input.blockerKind} end,
        blocker_code = case when request_seq > ${input.requestSeq} then null else ${input.blockerCode} end,
        blocker_message = case when request_seq > ${input.requestSeq} then null else ${input.blockerMessage} end,
        blocked_at = case when request_seq > ${input.requestSeq} then null else coalesce(blocked_at, ${now}) end,
        phase = ${input.phase ?? null},
        work_class = ${input.workClass ?? null},
        progress = ${input.progress ?? {}},
        consecutive_failures = case when request_seq > ${input.requestSeq} then 0 else ${nextFailures} end,
        last_error_code = case when request_seq > ${input.requestSeq} then null else ${input.errorCode} end,
        last_error_summary = case when request_seq > ${input.requestSeq} then null else ${input.errorSummary} end,
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where page_id = ${input.pageId}
      and stream = ${input.stream}
      and lease_token = ${input.leaseToken}
      and leased_seq = ${input.requestSeq}
      and status = 'running'
      and lease_expires_at > clock_timestamp()
    returning status,
              blocker_kind as "blockerKind"
  `);

  const updated = result.rows[0] ?? null;
  return {
    updated: updated !== null,
    blocked: updated?.status === "blocked" && updated.blockerKind === input.blockerKind,
  };
}

export async function markPageSyncAuthBlocked(
  db: Database,
  input: {
    pageId: number;
    errorCode: string | null;
    errorSummary: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  await db.execute(sql`
    update ${pageSyncStates}
    set status = 'blocked',
        retry_kind = null,
        retry_at = null,
        blocker_kind = 'auth',
        blocker_code = ${input.errorCode ?? "auth_blocked"},
        blocker_message = ${input.errorSummary},
        blocked_at = coalesce(blocked_at, ${now}),
        finished_at = ${now},
        failed_at = ${now},
        consecutive_failures = consecutive_failures + 1,
        last_error_code = ${input.errorCode},
        last_error_summary = ${input.errorSummary},
        lease_owner = null,
        lease_token = null,
        leased_seq = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where page_id = ${input.pageId}
      and status <> 'paused'
  `);
}

export async function clearPageSyncAuthBlock(
  db: Database,
  pageId: number,
  input: Date | {
    maxFailureAt?: Date;
    now?: Date;
  } = new Date(),
) {
  const now = input instanceof Date ? input : input.now ?? new Date();
  const maxFailureAt = input instanceof Date ? undefined : input.maxFailureAt;
  await db.execute(sql`
    update ${pageSyncStates}
    set status = case
                   when request_seq > applied_seq then 'pending'::page_sync_status
                   else 'idle'::page_sync_status
                 end,
        retry_kind = null,
        retry_at = null,
        blocker_kind = null,
        blocker_code = null,
        blocker_message = null,
        blocked_at = null,
        updated_at = ${now}
    where page_id = ${pageId}
      and blocker_kind = 'auth'
      and (
        ${maxFailureAt ?? null}::timestamptz is null or
        coalesce(failed_at, blocked_at, updated_at) <= ${maxFailureAt ?? null}
      )
  `);
}

export async function pausePageSync(
  db: Database,
  input: {
    pageId: number;
    streams: SyncStream[];
    now?: Date;
  },
) {
  if (input.streams.length === 0) {
    return;
  }

  const now = input.now ?? new Date();
  const streams = normalizePageSyncRequestStreams(input.streams);
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await listPageSyncStatesInternal(database, { pageId: input.pageId }, { lock: true });
    for (const stream of streams) {
      await database.execute(sql`
        update ${pageSyncStates}
        set status = 'paused',
            blocker_kind = case
                             when blocker_kind = ${FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND}
                               then null
                             else blocker_kind
                           end,
            blocker_code = case
                             when blocker_kind = ${FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND}
                               then null
                             else blocker_code
                           end,
            blocker_message = case
                                when blocker_kind = ${FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND}
                                  then null
                                else blocker_message
                              end,
            blocked_at = case
                           when blocker_kind = ${FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND}
                             then null
                           else blocked_at
                         end,
            leased_seq = null,
            lease_owner = null,
            lease_token = null,
            lease_heartbeat_at = null,
            lease_expires_at = null,
            updated_at = ${now}
        where page_id = ${input.pageId}
          and stream = ${stream}
      `);
    }
  });
}

/**
 * Kernel Stage 26: typed auth death parks every runnable stream on the page
 * with blocker_kind='auth', so quota stops burning on a dead session. Streams
 * already parked by an operator or feature gate keep that ownership marker.
 * clearPageSyncAuthBlock can therefore restore only the rows auth paused.
 */
export async function pausePageSyncForAuth(
  db: Database,
  input: {
    pageId: number;
    streams: SyncStream[];
    blockerCode: string;
    blockerMessage: string;
    now?: Date;
  },
) {
  if (input.streams.length === 0) {
    return;
  }

  const now = input.now ?? new Date();
  const streams = normalizePageSyncRequestStreams(input.streams);
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await listPageSyncStatesInternal(database, { pageId: input.pageId }, { lock: true });
    for (const stream of streams) {
      await database.execute(sql`
        update ${pageSyncStates}
        set status = 'paused',
            blocker_kind = 'auth',
            blocker_code = ${input.blockerCode},
            blocker_message = ${input.blockerMessage},
            blocked_at = ${now},
            leased_seq = null,
            lease_owner = null,
            lease_token = null,
            lease_heartbeat_at = null,
            lease_expires_at = null,
            updated_at = ${now}
        where page_id = ${input.pageId}
          and stream = ${stream}
          -- An already-paused stream is owned by a feature gate or an
          -- operator. It is already safely parked; auth must not replace the
          -- marker that tells the matching resume path who may release it.
          -- Auth-owned rows may refresh their own diagnostic timestamp.
          and (status <> 'paused' or blocker_kind = 'auth')
      `);
    }
  });
}

export async function resumePageSync(
  db: Database,
  input: {
    pageId: number;
    streams: SyncStream[];
    now?: Date;
  },
) {
  if (input.streams.length === 0) {
    return;
  }

  const now = input.now ?? new Date();
  const streams = normalizePageSyncRequestStreams(input.streams);
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await listPageSyncStatesInternal(database, { pageId: input.pageId }, { lock: true });
    for (const stream of streams) {
      await database.execute(sql`
        update ${pageSyncStates}
        set status = case
                       when blocker_kind is not null then 'blocked'::page_sync_status
                       when request_seq > applied_seq then 'pending'::page_sync_status
                       else 'idle'::page_sync_status
                     end,
            updated_at = ${now}
        where page_id = ${input.pageId}
          and stream = ${stream}
          and status = 'paused'
          and blocker_kind is distinct from ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND}
      `);
    }
  });
}

export async function resetPageSync(
  db: Database,
  input: {
    pageId: number;
    streams: SyncStream[];
    now?: Date;
  },
) {
  if (input.streams.length === 0) {
    return;
  }

  const now = input.now ?? new Date();
  const streams = normalizePageSyncRequestStreams(input.streams);
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await listPageSyncStatesInternal(database, { pageId: input.pageId }, { lock: true });
    for (const stream of streams) {
      await database.execute(sql`
        update ${pageSyncStates}
        set leased_seq = null,
            retry_kind = null,
            retry_at = null,
            blocker_kind = case when blocker_kind in ('auth', ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND}) then blocker_kind else null end,
            blocker_code = case when blocker_kind in ('auth', ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND}) then blocker_code else null end,
            blocker_message = case when blocker_kind in ('auth', ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND}) then blocker_message else null end,
            blocked_at = case when blocker_kind in ('auth', ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND}) then blocked_at else null end,
            phase = null,
            progress = '{}'::jsonb,
            lease_owner = null,
            lease_token = null,
            lease_heartbeat_at = null,
            lease_expires_at = null,
            consecutive_failures = 0,
            last_error_code = null,
            last_error_summary = null,
            status = case
                       when status = 'paused' then 'paused'::page_sync_status
                       when blocker_kind = ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND} then 'paused'::page_sync_status
                       when blocker_kind = 'auth' then 'blocked'::page_sync_status
                       else 'idle'::page_sync_status
                     end,
            updated_at = ${now}
        where page_id = ${input.pageId}
          and stream = ${stream}
      `);
    }
  });
}

export async function requestPageSync(
  db: Database,
  input: {
    pageId: number;
    streams: SyncStream[];
    source: SyncRequestSource;
    requestPayloadByStream?: Partial<Record<SyncStream, Record<string, unknown> | null>>;
    now?: Date;
    dependencyOptions?: PageSyncDependencyOptions;
  },
) {
  const now = input.now ?? new Date();
  const requestedStreams = normalizePageSyncRequestStreams(input.streams);
  const results: Array<{ stream: SyncStream; requestedSeq: number }> = [];

  await ensurePageSyncStates(db, {
    pageId: input.pageId,
    onboarding: input.source === "onboarding",
    now,
    dependencyOptions: input.dependencyOptions,
  });

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const lockedRows = await listPageSyncStatesInternal(database, { pageId: input.pageId }, { lock: true });
    const lockedRowsByStream = new Map(lockedRows.map((row) => [row.stream, row] as const));

    const leaseExpiryResult = await database.execute<{ stream: SyncStream; leaseExpired: boolean }>(sql`
      select stream as "stream",
             (
               leased_seq is not null
               and lease_token is not null
               and lease_expires_at <= clock_timestamp()
             ) as "leaseExpired"
      from ${pageSyncStates}
      where page_id = ${input.pageId}
        and stream = any(${streamArraySql(requestedStreams)})
    `);
    const leaseExpiredByStream = new Map(
      leaseExpiryResult.rows.map((row) => [row.stream, row.leaseExpired] as const),
    );

    for (const stream of requestedStreams) {
      const current = lockedRowsByStream.get(stream);
      if (!current) {
        throw new Error(`Sync stream "${stream}" does not exist for page ${input.pageId}`);
      }

      const nextRequestSeq = current.requestSeq + 1;
      const rawRequestPayload = input.requestPayloadByStream?.[stream] ?? {};
      const requestPayload = Object.keys(rawRequestPayload).length > 0
        ? { ...rawRequestPayload, revision: nextRequestSeq }
        : rawRequestPayload;
      const leaseExpired = leaseExpiredByStream.get(stream);
      if (leaseExpired === undefined) {
        throw new Error(`Sync stream "${stream}" disappeared while requesting page ${input.pageId}`);
      }
      const nextStatus: PageSyncStatus = current.status === "paused"
        ? "paused"
        : current.status === "blocked"
          ? "blocked"
          : current.status === "running" && !leaseExpired
            ? "running"
            : "pending";
      const clearExpiredLease = leaseExpired && nextStatus === "pending";

      await database.execute(sql`
        update ${pageSyncStates}
        set request_seq = ${nextRequestSeq},
            request_source = ${input.source},
            dispatch_source = ${input.source},
            request_payload = ${requestPayload},
            requested_at = ${now},
            status = ${nextStatus}::page_sync_status,
            retry_kind = case when ${nextStatus === "pending"} then null else retry_kind end,
            retry_at = case when ${nextStatus === "pending"} then null else retry_at end,
            leased_seq = case when ${clearExpiredLease} then null else leased_seq end,
            lease_owner = case when ${clearExpiredLease} then null else lease_owner end,
            lease_token = case when ${clearExpiredLease} then null else lease_token end,
            lease_heartbeat_at = case when ${clearExpiredLease} then null else lease_heartbeat_at end,
            lease_expires_at = case when ${clearExpiredLease} then null else lease_expires_at end,
            updated_at = ${now}
        where page_id = ${input.pageId}
          and stream = ${stream}
      `);
      lockedRowsByStream.set(stream, {
        ...current,
        requestSeq: nextRequestSeq,
        requestSource: input.source,
        dispatchSource: input.source,
        requestPayload,
        requestedAt: now,
        status: nextStatus,
        retryKind: nextStatus === "pending" ? null : current.retryKind,
        retryAt: nextStatus === "pending" ? null : current.retryAt,
        leasedSeq: clearExpiredLease ? null : current.leasedSeq,
        leaseOwner: clearExpiredLease ? null : current.leaseOwner,
        leaseToken: clearExpiredLease ? null : current.leaseToken,
        leaseHeartbeatAt: clearExpiredLease ? null : current.leaseHeartbeatAt,
        leaseExpiresAt: clearExpiredLease ? null : current.leaseExpiresAt,
        updatedAt: now,
      });

      results.push({
        stream,
        requestedSeq: nextRequestSeq,
      });
    }

    await refreshLockedPageSyncDependencies(
      database,
      lockedRows.map((row) => lockedRowsByStream.get(row.stream) ?? row),
      now,
      input.dependencyOptions,
    );
  });

  return results;
}
