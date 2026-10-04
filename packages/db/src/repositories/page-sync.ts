import { and, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  egressEndpoints,
  pageSyncStates,
  pages,
} from "../schema.ts";
import { egressKeySql } from "./egress.ts";

type TimestampValue = Date | string | null | undefined;
type NumericValue = number | bigint | null | undefined;

// The `sync_stream` vocabulary: every value of the database enum. Rows of
// `page_sync_states`, `page_sync_cursors`, `sync_runs` and their telemetry
// carry these names for good, so the type keeps them all. The legacy
// page-sync executor runs only `LEGACY_EXECUTOR_STREAMS` (below); the other
// names are records of the Fansly lanes it ran until step 4 and the names the
// Fansly Sync Engine's status surfaces and levers still address its registry
// keys by (`apps/runtime/src/sync/fansly/registry.ts`, the lever map).
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
  "stats_snapshot",
  "notifications",
  "catalog",
  "post_replies",
  "payouts",
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
  | "event"
  | "reset";
export type SyncWorkClass = "live" | "history" | "maintenance";

/** The streams the legacy page-sync executor runs: OnlyFans's, the one
 *  platform it serves since step 4 (owner decision №13). Each has a row in
 *  `SYNC_STREAM_POLICY` and a pull handler in the platform registry. Fansly
 *  has none: the Fansly Sync Engine reads every Fansly page, and the names of
 *  its former lanes stay in `SYNC_STREAMS` as records only. */
export const LEGACY_EXECUTOR_STREAMS = [
  "light",
  "transactions",
  "fan_identities",
  "top_spenders",
  "subscribers",
  "dm_conversations",
  "posts",
] as const satisfies readonly SyncStream[];

export type LegacyExecutorStream = typeof LEGACY_EXECUTOR_STREAMS[number];

/** Whether the legacy executor runs `stream` (it has a policy row). A row of
 *  any other stream is a record: a parked Fansly lane (step 4, S4-21) or
 *  OnlyFans's retired `dm_messages`. */
export function isLegacyExecutorStream(stream: string): stream is LegacyExecutorStream {
  return (LEGACY_EXECUTOR_STREAMS as readonly string[]).includes(stream);
}

/** The blocker a rollout gate once put on a Fansly bulk stream. Nothing sets
 *  it any more; `pausePageSync` still clears one it meets. */
export const FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND = "feature_gate";

/**
 * Streams that seed PAUSED, with no blocker (paused-without-a-blocker is
 * distinguishable from a blocked row). Every other stream seeds
 * `pending`/recovery, so a gated-off stream added to the executor without an
 * entry here would seed one pending row per page, fleet-wide, on the deploy
 * that ships it. Ungating stays an explicit act: an operator uses the stream's
 * own sync scope.
 */
export const SEED_PAUSED_SYNC_STREAMS = [
  "posts",
] as const satisfies readonly LegacyExecutorStream[];

export function isSeedPausedSyncStream(stream: string): boolean {
  return (SEED_PAUSED_SYNC_STREAMS as readonly string[]).includes(stream);
}

export interface SyncStreamPolicy {
  stream: LegacyExecutorStream;
  domain: SyncDomain;
  cadenceSeconds: number;
  basePriority: number;
  streamIndex: number;
  defaultWorkClass: SyncWorkClass;
  /** How long runnable work may wait before status reports it delayed. */
  queueDelayThresholdMs: number;
  progressStallThresholdMs: number;
  freshnessSlaSeconds: number | null;
}

export interface SyncDomainPolicy {
  domain: SyncDomain;
  primaryStreams: LegacyExecutorStream[];
  supportingStreams: LegacyExecutorStream[];
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

// One row per stream the legacy executor runs. The Fansly lanes' rows went at
// step 4 (S4-24): the Fansly Sync Engine's registry holds their periods,
// classes and SLOs (`apps/runtime/src/sync/fansly/registry.ts`). `streamIndex`
// keeps each stream's historical number (the slot offsets of the stored rows
// are computed from it), so the numbers are not contiguous.
export const SYNC_STREAM_POLICY: Record<LegacyExecutorStream, SyncStreamPolicy> = {
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
  // Every 6 h (owner decision 2026-09-30). It reads local transactions only,
  // and nothing judges its freshness: the DM lane waits only for its FIRST
  // success (dependencyMet).
  top_spenders: {
    stream: "top_spenders",
    domain: "financials",
    cadenceSeconds: 6 * 3600,
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
};

/** The policy of a stream the legacy executor runs, or null for a stream it
 *  does not (a record row). */
export function syncStreamPolicy(stream: SyncStream): SyncStreamPolicy | null {
  return isLegacyExecutorStream(stream) ? SYNC_STREAM_POLICY[stream] : null;
}

// The Settings blocks of a page the legacy executor serves. `messages_history`
// has no stream: OnlyFans's history is acquired by its mirror jobs (the
// legacy `dm_messages` crawler is retired), so the block reads not available.
// A Fansly page's blocks are the engine's
// (`apps/runtime/src/services/sync-status-engine.ts`).
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
    primaryStreams: ["subscribers"],
    supportingStreams: [],
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
    primaryStreams: [],
    supportingStreams: [],
    freshnessSlaSeconds: null,
  },
};

/** What a stream waits for before its first run (a dependency the page has
 *  no row for is ignored). */
export const SYNC_STREAM_DEPENDENCIES: Partial<Record<LegacyExecutorStream, LegacyExecutorStream[]>> = {
  top_spenders: ["transactions"],
  dm_conversations: ["light", "top_spenders", "transactions", "subscribers"],
};

const SYNC_STREAM_PRIORITY_BY_SOURCE: Record<SyncRequestSource, Record<LegacyExecutorStream, number>> = {
  scheduled: {
    light: 60,
    transactions: 50,
    fan_identities: 49,
    top_spenders: 45,
    subscribers: 40,
    dm_conversations: 30,
    posts: 18,
  },
  event: {
    light: 60,
    transactions: 50,
    fan_identities: 49,
    top_spenders: 45,
    subscribers: 40,
    dm_conversations: 30,
    posts: 18,
  },
  recovery: {
    light: 70,
    transactions: 60,
    fan_identities: 59,
    top_spenders: 55,
    subscribers: 50,
    dm_conversations: 40,
    posts: 28,
  },
  anomaly: {
    light: 70,
    transactions: 60,
    fan_identities: 59,
    top_spenders: 55,
    subscribers: 50,
    dm_conversations: 40,
    posts: 28,
  },
  manual: {
    light: 100,
    transactions: 90,
    fan_identities: 89,
    top_spenders: 85,
    subscribers: 80,
    dm_conversations: 70,
    posts: 58,
  },
  onboarding: {
    light: 100,
    transactions: 90,
    fan_identities: 89,
    top_spenders: 85,
    subscribers: 80,
    dm_conversations: 70,
    posts: 58,
  },
  reset: {
    light: 100,
    transactions: 90,
    fan_identities: 89,
    top_spenders: 85,
    subscribers: 80,
    dm_conversations: 70,
    posts: 58,
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

/** The platforms a page-sync query serves: the platform registry's
 *  legacy-executor set (`legacyExecutorPlatforms`, OnlyFans only since step 4
 *  S4-10). The queries that pick work — the runnable listing, the enqueue mark
 *  and the lease — take it as a required argument: since step 4 (S4-21) it is
 *  the one fence between the legacy executor and a Fansly page (the
 *  `sync_pages` mode predicate they carried through step 3 is gone). The
 *  queries that only maintain state take it optionally; absent means every
 *  platform. */
export type PageSyncPlatformScope = readonly ("fansly" | "onlyfans")[];

/** `page_id` belongs to a page of one of `platforms` (true without a scope). */
function pageSyncPlatformScopeSql(pageIdColumn: string, platforms: PageSyncPlatformScope | undefined) {
  if (platforms === undefined) return sql`true`;
  if (platforms.length === 0) return sql`false`;
  return sql`${sql.raw(pageIdColumn)} in (
    select scoped.id from ${pages} scoped
    where scoped.platform in (${sql.join(platforms.map((platform) => sql`${platform}`), sql`, `)})
  )`;
}

/** A stream's place in the one order a page's rows are listed and locked in:
 *  the executor's streams by `streamIndex`, then the record streams in
 *  vocabulary order. A total order, so two writers that lock a page's rows
 *  take them the same way whatever rows the page holds. */
export function syncStreamOrderIndex(stream: SyncStream): number {
  return syncStreamPolicy(stream)?.streamIndex ?? RECORD_STREAM_ORDER_BASE + SYNC_STREAMS.indexOf(stream);
}

const RECORD_STREAM_ORDER_BASE = 100;

/** `syncStreamOrderIndex` as a SQL `case` over a stream column: the only
 *  ladder (the lock order, the lease tie-break and the ops listing share it). */
export function syncStreamOrderSql(columnName: string) {
  const ladder = SYNC_STREAMS
    .map((stream) => `when '${stream}' then ${syncStreamOrderIndex(stream)}`)
    .join("\n      ");
  return sql.raw(`
    case ${columnName}
      ${ladder}
      else 999
    end
  `);
}

function streamPriorityBySourceSql(streamColumnName: string, sourceColumnName: string) {
  const priorityCase = (source: SyncRequestSource) => `
    case ${streamColumnName}
      ${LEGACY_EXECUTOR_STREAMS
        .map((stream) => `when '${stream}' then ${SYNC_STREAM_PRIORITY_BY_SOURCE[source][stream]}`)
        .join("\n      ")}
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
      when 'event' then ${priorityCase("event")}
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

// OnlyFans: subscribers is the OFAPI audience sweep (docs/ofapi-parity-plan.md
// Phase 3) and top_spenders is computed from the transactions table (Phase 5);
// the planner force-pauses both for pages outside their flags, mirroring the
// DM-polling gate. Fansly: none since step 4 (S4-10, the rows deleted in
// S4-24) — the Fansly Sync Engine reads every Fansly page.
const LEGACY_EXECUTOR_STREAMS_BY_PLATFORM: Record<"fansly" | "onlyfans", readonly LegacyExecutorStream[]> = {
  fansly: [],
  onlyfans: LEGACY_EXECUTOR_STREAMS,
};

/** The streams the legacy page-sync executor runs on a platform's pages. */
export function getSyncStreamsForPlatform(platform: "fansly" | "onlyfans"): LegacyExecutorStream[] {
  return [...LEGACY_EXECUTOR_STREAMS_BY_PLATFORM[platform]];
}

/** The platforms the legacy executor has a stream for (OnlyFans only): the
 *  same set the platform registry declares (`legacyExecutorPlatforms`, pinned
 *  equal by tests/sync-onlyfans-boundary.test.ts), for the SQL surfaces of
 *  this package that cannot read the runtime's registry. */
export const LEGACY_EXECUTOR_PLATFORMS: ReadonlyArray<"fansly" | "onlyfans"> =
  (Object.keys(LEGACY_EXECUTOR_STREAMS_BY_PLATFORM) as Array<"fansly" | "onlyfans">)
    .filter((platform) => LEGACY_EXECUTOR_STREAMS_BY_PLATFORM[platform].length > 0);

export const ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND = "retired";
export const ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_CODE =
  "legacy_ofapi_dm_messages_retired";
export const ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_MESSAGE =
  "Legacy OnlyFans dm_messages crawler is permanently retired; history acquisition is owned by durable OF mirror jobs";

// The cadence and slot index a parked OnlyFans `dm_messages` row is written
// with. The stream has no policy row (nothing runs it): these fill the row's
// NOT NULL schedule columns with the values the lane had when it ran.
const RETIRED_DM_MESSAGES_CADENCE_SECONDS = 86_400;
const RETIRED_DM_MESSAGES_STREAM_INDEX = 9;

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
             ${RETIRED_DM_MESSAGES_CADENCE_SECONDS},
             mod(
               (p.id::bigint * 2654435761::bigint) +
                 (${RETIRED_DM_MESSAGES_STREAM_INDEX}::bigint * 2246822519::bigint),
               ${RETIRED_DM_MESSAGES_CADENCE_SECONDS}::bigint
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

/** A request's queue priority; 0 for a stream the executor does not run. */
export function resolvePageSyncPriority(stream: SyncStream, source: SyncRequestSource) {
  return isLegacyExecutorStream(stream) ? SYNC_STREAM_PRIORITY_BY_SOURCE[source][stream] : 0;
}

export function computePageSyncSlotOffsetSeconds(
  pageId: number,
  stream: LegacyExecutorStream,
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

/**
 * Re-expresses `last_scheduled_slot` on a new slot grid (a changed cadence or
 * slot offset). Slot numbers only mean something on their own grid: an hourly
 * slot number read on a 6-hour grid lies centuries ahead, so the planner would
 * never claim the lane again. What carries over is the instant the last
 * scheduled slot began: the new-grid slot holding it counts as scheduled, so
 * the next request lands on the first new boundary after it. A longer cadence
 * gets no catch-up run; a shorter one gets at most one, when a new boundary
 * has already passed.
 */
export function rebasePageSyncLastScheduledSlot(input: {
  lastScheduledSlot: number;
  from: { cadenceSeconds: number; slotOffsetSeconds: number };
  to: { cadenceSeconds: number; slotOffsetSeconds: number };
}) {
  if (input.lastScheduledSlot < 0) {
    return input.lastScheduledSlot;
  }

  const scheduledAtSeconds = input.lastScheduledSlot * input.from.cadenceSeconds +
    input.from.slotOffsetSeconds;
  return Math.max(
    -1,
    Math.floor((scheduledAtSeconds - input.to.slotOffsetSeconds) / input.to.cadenceSeconds),
  );
}

export function normalizePageSyncRequestStreams(streams: readonly SyncStream[]) {
  return [...new Set(streams)].sort((left, right) => syncStreamOrderIndex(left) - syncStreamOrderIndex(right));
}

function buildSeedPageSyncState(
  page: {
    id: number;
    platform: "fansly" | "onlyfans";
    lastLightSyncAt: Date | null;
  },
  stream: LegacyExecutorStream,
  now: Date,
  onboarding: boolean,
): typeof pageSyncStates.$inferInsert {
  const policy = SYNC_STREAM_POLICY[stream];
  const slotOffsetSeconds = computePageSyncSlotOffsetSeconds(page.id, stream);
  const currentSlot = computeCurrentPageSyncSlot(now, policy.cadenceSeconds, slotOffsetSeconds);
  // The one stream whose last success the page row records.
  const trustedAt = stream === "light" ? page.lastLightSyncAt : null;
  const shouldRecover = onboarding || trustedAt === null;
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
    platforms?: PageSyncPlatformScope;
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

  if (input?.platforms !== undefined) {
    clauses.push(pageSyncPlatformScopeSql("page_id", input.platforms));
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
    order by page_id asc, ${syncStreamOrderSql("stream")} asc
    ${options?.lock ? sql`for update` : sql``}
  `);

  return result.rows.map((row) => normalizePageSyncState(row));
}

/** Locks every page_sync_states row of one page in the ORDER pausePageSync / pausePageSyncForAuth /
 * resumePageSync / resetPageSync take them (listPageSyncStatesInternal with lock:true). Any writer that
 * reads blocker state and then rewrites it must hold these locks for the whole read-decide-write, or a
 * concurrent Resume can move a row between the read and the write (#132/4, PLAN AUDIT 01). */
export async function lockPageSyncStatesForPage(db: Database, pageId: number) {
  return listPageSyncStatesInternal(db, { pageId }, { lock: true });
}

export async function listPageSyncStates(
  db: Database,
  input?: {
    pageId?: number;
    streams?: SyncStream[];
    /** Only these platforms' pages; every platform when absent. */
    platforms?: PageSyncPlatformScope;
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

async function repairLegacyLightTrustedPageSyncStates(
  db: Database,
  input: {
    pageId?: number;
    platforms?: PageSyncPlatformScope;
    now: Date;
  },
) {
  const pageClause = input.pageId === undefined
    ? pageSyncPlatformScopeSql("st.page_id", input.platforms)
    : sql`st.page_id = ${input.pageId} and ${pageSyncPlatformScopeSql("st.page_id", input.platforms)}`;

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
      and st.stream = 'transactions'::sync_stream
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
    /** Seed and maintain only these platforms' pages (the planner and the
     *  executor pass the legacy-executor set); every platform the executor
     *  serves when absent. */
    platforms?: PageSyncPlatformScope;
  },
) {
  const now = input?.now ?? new Date();
  // A platform the executor runs no stream on (Fansly) has nothing to seed,
  // repair or reschedule: the rows its pages hold are records, and stay as
  // they were written whatever scope the caller names.
  const platforms: PageSyncPlatformScope = (input?.platforms ?? LEGACY_EXECUTOR_PLATFORMS)
    .filter((platform) => LEGACY_EXECUTOR_PLATFORMS.includes(platform));
  // Tombstoned pages (deletePageByLabel) must never get sync states seeded
  // or maintained — a deleted page otherwise re-enters the planner forever.
  const clauses = [sql`p.status = 'active'`, pageSyncPlatformScopeSql("p.id", platforms)];
  if (input?.pageId !== undefined) {
    clauses.push(sql`p.id = ${input.pageId}`);
  }

  const pageRows = await db.execute<{
    id: NumericValue;
    platform: unknown;
    lastLightSyncAt: TimestampValue;
  }>(sql`
    select p.id as "id",
           p.platform as "platform",
           p.last_light_sync_at as "lastLightSyncAt"
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
  }));

  const scope = {
    ...(input?.pageId !== undefined ? { pageId: input.pageId } : {}),
    platforms,
  };
  const existingRows = await listPageSyncStatesInternal(db, scope);
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
    platforms,
    now,
  });

  const refreshedRows = await listPageSyncStatesInternal(db, scope);

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    for (const row of refreshedRows) {
      // A record row (OnlyFans's retired dm_messages) has no policy: its
      // schedule columns stay as they were written.
      if (!isLegacyExecutorStream(row.stream)) {
        continue;
      }
      const policy = SYNC_STREAM_POLICY[row.stream];
      const slotOffsetSeconds = computePageSyncSlotOffsetSeconds(row.pageId, row.stream);
      if (
        row.cadenceSeconds === policy.cadenceSeconds &&
        row.slotOffsetSeconds === slotOffsetSeconds
      ) {
        continue;
      }

      // The slot moves with the grid, or a longer cadence would never be
      // scheduled again. Compare-and-set on the values it was computed from:
      // if the planner claimed a slot meanwhile, the next call redoes it.
      const lastScheduledSlot = rebasePageSyncLastScheduledSlot({
        lastScheduledSlot: row.lastScheduledSlot,
        from: { cadenceSeconds: row.cadenceSeconds, slotOffsetSeconds: row.slotOffsetSeconds },
        to: { cadenceSeconds: policy.cadenceSeconds, slotOffsetSeconds },
      });
      await database.execute(sql`
        update ${pageSyncStates}
        set cadence_seconds = ${policy.cadenceSeconds},
            slot_offset_seconds = ${slotOffsetSeconds},
            last_scheduled_slot = ${lastScheduledSlot},
            updated_at = ${now}
        where page_id = ${row.pageId}
          and stream = ${row.stream}
          and cadence_seconds = ${row.cadenceSeconds}
          and slot_offset_seconds = ${row.slotOffsetSeconds}
          and last_scheduled_slot = ${row.lastScheduledSlot}
      `);
    }
  });

  return listPageSyncStatesInternal(db, scope);
}

/**
 * Stream dependencies are a legacy ordering concern (hydrate account and
 * audience before DMs). OFAPI-fed OnlyFans DM streams are independent of the
 * legacy light/financial/audience sweeps; a legacy/unmapped OnlyFans page
 * keeps the ordering. A stream the executor does not run on the page's
 * platform (every stream of a Fansly page) has no dependency: its row is a
 * record, and the refresh below neither blocks nor releases it.
 */
const ONLYFANS_OFAPI_DM_EXCLUDED_DEPENDENCIES: readonly LegacyExecutorStream[] = [
  "light",
  "transactions",
  "subscribers",
  "top_spenders",
];

const ONLYFANS_DM_DEPENDENCY_EXEMPT_STREAMS: readonly SyncStream[] = [
  "dm_conversations",
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
  const base: readonly LegacyExecutorStream[] =
    isLegacyExecutorStream(input.stream) && LEGACY_EXECUTOR_STREAMS_BY_PLATFORM[input.platform].includes(input.stream)
      ? SYNC_STREAM_DEPENDENCIES[input.stream] ?? []
      : [];
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
    /** Only these platforms' pages; every platform when absent. */
    platforms?: PageSyncPlatformScope;
  },
) {
  const now = input?.now ?? new Date();
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const rows = await listPageSyncStatesInternal(
      database,
      {
        ...(input?.pageId !== undefined ? { pageId: input.pageId } : {}),
        ...(input?.platforms !== undefined ? { platforms: input.platforms } : {}),
      },
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
    // The rows of a platform the executor does not serve are records.
    if (!LEGACY_EXECUTOR_PLATFORMS.includes(context.platform)) continue;
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
  options?: {
    /** Only these platforms' pages; every platform when absent. */
    platforms?: PageSyncPlatformScope;
  },
) {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const reclaimable = await listPageSyncStatesInternal(
      database,
      options?.platforms !== undefined ? { platforms: options.platforms } : undefined,
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
    /** Schedule only these platforms' pages (the planner passes the
     *  legacy-executor set); every platform when absent. Rows of other
     *  platforms are neither seeded, reclaimed, requested nor unblocked. */
    platforms?: PageSyncPlatformScope;
  },
) {
  const now = input?.now ?? new Date();
  const platforms = input?.platforms;
  const scope = {
    ...(input?.pageId !== undefined ? { pageId: input.pageId } : {}),
    ...(platforms !== undefined ? { platforms } : {}),
  };
  await ensurePageSyncStates(db, {
    pageId: input?.pageId,
    now,
    dependencyOptions: input?.dependencyOptions,
    ...(platforms !== undefined ? { platforms } : {}),
  });
  await reclaimExpiredPageSync(db, now, platforms !== undefined ? { platforms } : undefined);

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const rows = await listPageSyncStatesInternal(database, scope, { lock: true });

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
          // A waited-out retry_at stays: every runnable filter already treats
          // a past deadline as eligible. The next lease outcome or request
          // rewrites it.
          await database.execute(sql`
            update ${pageSyncStates}
            set status = 'pending',
                retry_kind = null,
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
    ...(platforms !== undefined ? { platforms } : {}),
  });

  return listPageSyncStatesInternal(db, scope);
}

export async function listRunnablePageSync(
  db: Database,
  now: Date,
  options: {
    /** Only these platforms' pages: the planner and the executor pass the
     *  legacy-executor set. */
    platforms: PageSyncPlatformScope;
  },
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
        and ${pageSyncPlatformScopeSql("st.page_id", options.platforms)}
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
  now: Date,
  options: {
    /** Only a page of these platforms (the planner passes the
     *  legacy-executor set). */
    platforms: PageSyncPlatformScope;
  },
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
      and ${pageSyncPlatformScopeSql("page_id", options.platforms)}
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
    /** Lease only a stream of these platforms' pages (the executor passes
     *  the legacy-executor set). */
    platforms: PageSyncPlatformScope;
  },
) {
  const now = input.now ?? new Date();
  // Strict table priority; the same priority goes oldest request first.
  const result = await db.execute<Record<string, unknown>>(sql`
    with runnable as (
      select st.page_id as "pageId",
             st.stream as "stream",
             st.request_seq as "requestSeq",
             st.requested_at,
             ${streamPriorityBySourceSql("st.stream", "st.dispatch_source")} as priority
      from ${pageSyncStates} st
      inner join ${pages} p on p.id = st.page_id and p.status = 'active'
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
        and ${pageSyncPlatformScopeSql("st.page_id", input.platforms)}
    ), candidate as (
      select r."pageId", r."stream", r."requestSeq"
      from runnable r
      order by r.priority desc,
               r.requested_at asc nulls last,
               ${syncStreamOrderSql('r."stream"')} asc
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

/** The durable per-stream backoff ladder: 60s doubling per consecutive
 * failure, capped at 30 minutes. Exported because a caller that supplies its
 * own `retryAt` (a provider `Retry-After`, a policy reset instant) has to be
 * able to take the LATER of the two — an explicit deadline may postpone a
 * stream, never pull it forward into the same wall it just hit. */
export function pageSyncRetryBackoffMs(consecutiveFailures: number) {
  const seconds = 60 * (2 ** Math.max(0, consecutiveFailures - 1));
  return Math.min(seconds, 30 * 60) * 1000;
}

/** The retry or pacing deadline a row is still waiting for, or null once it
 * has passed. The planner leaves a passed retry_at on a pending row (see
 * scheduleDuePageSync), so status readers report a retry through this. */
export function activePageSyncRetryAt(retryAt: Date | null, now: Date) {
  return retryAt !== null && retryAt.getTime() > now.getTime() ? retryAt : null;
}

function hasProviderCooldown(retryKind: string | null, retryAt: Date | null, now: Date) {
  return (retryKind === "rate_limit" || retryKind === "provider_5xx") &&
    retryAt !== null && retryAt.getTime() > now.getTime();
}

export async function retryPageSync(
  db: Database,
  input: {
    pageId: number;
    stream: SyncStream;
    requestSeq: number;
    leaseToken: string;
    retryKind: string;
    /** Wake up at this instant instead of the consecutive-failure backoff
     * (a collection-policy cap knows exactly when it resets, review #136). */
    retryAt?: Date | null;
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
  const retryAt = input.retryAt ?? new Date(now.getTime() + pageSyncRetryBackoffMs(nextFailures));
  // A newer request replaces queued work, but cannot bypass a provider cooldown.
  // Replacing only drops this attempt's retry gate: the failure itself still
  // counts, so an operator "Sync now" pressed during a failing chunk keeps the
  // streak and last error that alerting and retry_wedged read.
  const discardRetry = sql`request_seq > ${input.requestSeq}
    and ${!hasProviderCooldown(input.retryKind, retryAt, now)}`;
  const result = await db.execute(sql<{ status: PageSyncStatus; retryKind: string | null }>`
    update ${pageSyncStates}
    set status = case
                   when ${discardRetry} then 'pending'::page_sync_status
                   else 'retrying'::page_sync_status
                 end,
        leased_seq = null,
        progressed_at = coalesce(${input.progressedAt ?? null}, progressed_at),
        finished_at = ${now},
        failed_at = ${now},
        retry_kind = case when ${discardRetry} then null else ${input.retryKind} end,
        retry_at = case when ${discardRetry} then null::timestamptz else ${retryAt} end,
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
        consecutive_failures = ${nextFailures},
        last_error_code = ${input.errorCode},
        last_error_summary = ${input.errorSummary},
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
  // A newer request replaces the block with pending work, but the failure
  // still counts (see retryPageSync): its streak and last error stay.
  const result = await db.execute(sql<{ status: PageSyncStatus; blockerKind: string | null }>`
    update ${pageSyncStates}
    set status = case
                   when request_seq > ${input.requestSeq} then 'pending'::page_sync_status
                   else 'blocked'::page_sync_status
                 end,
        leased_seq = null,
        progressed_at = coalesce(${input.progressedAt ?? null}, progressed_at),
        finished_at = ${now},
        failed_at = ${now},
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
        consecutive_failures = ${nextFailures},
        last_error_code = ${input.errorCode},
        last_error_summary = ${input.errorSummary},
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

/**
 * Decision #249: an EXPLICIT operator request for a stream is the manual
 * action a `manual_action_required` block was waiting for. Clears that block
 * (and only that kind — a provider_bad_data or dependency block is not the
 * operator's to wave away) on the named streams, so the request that follows
 * lands on a runnable row. If the cause is still there, the next run re-parks
 * the stream with the same code; nothing is lost.
 */
export async function clearPageSyncManualActionBlock(
  db: Database,
  input: {
    pageId: number;
    streams: SyncStream[];
    now?: Date;
  },
) {
  if (input.streams.length === 0) {
    return 0;
  }
  const now = input.now ?? new Date();
  const streams = normalizePageSyncRequestStreams(input.streams);
  const result = await db.execute<{ stream: string }>(sql`
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
    where page_id = ${input.pageId}
      and stream in (${sql.join(streams.map((stream) => sql`${stream}`), sql`, `)})
      and status = 'blocked'
      and blocker_kind = 'manual_action_required'
    returning stream
  `);
  return result.rows.length;
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
            ofapi_user_paused = exists(select 1 from pages p where p.id = ${input.pageId} and p.platform = 'onlyfans'),
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
 * already parked by an operator or feature gate keep that ownership marker,
 * so the recovery (the OFAPI account-health handler, by `blocker_kind = 'auth'`
 * and its binding generation) restores only the rows auth paused.
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
        set ofapi_user_paused = false,
            status = case
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

/** A settle-only B1 wake skips the AI media accelerator step that the other
 * event wakes rely on. A plain event wake takes its place while it is queued,
 * or queues behind it while it runs, instead of being dropped. */
function supersedesSettleOnlyWake(current: PageSyncState, payload: Record<string, unknown> | null | undefined) {
  return current.requestSource === "event" && current.requestPayload.fanslyWsHintSettleOnly === true
    && payload?.fanslyWsHintSettleOnly !== true && (current.status === "pending" || current.status === "running");
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
    /** Diagnostic receipt from the same locked row; omitted for ordinary callers. */
    includeQueueState?: boolean;
    /**
     * Fold this request into an outstanding revision instead of bumping it.
     * For intent-free repeats only: a bump would discard the in-flight
     * cursor, its restart bound and any backoff of the outstanding work.
     */
    coalesceOutstanding?: boolean;
  },
) {
  const now = input.now ?? new Date();
  const requestedStreams = normalizePageSyncRequestStreams(input.streams);
  const results: Array<{
    stream: SyncStream;
    requestedSeq: number;
    coalesced?: true;
    queueBefore?: { requestedSeq: number; appliedSeq: number };
  }> = [];

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

      // B1 can wake an idle DM stream for one budgeted target. Never replace
      // queued ordinary work with an event-only request; the ordinary chunk
      // can consume the same durable subject queue itself.
      if (input.source === "event" && !(stream === "dm_messages" && (current.requestSeq > current.appliedSeq
        ? supersedesSettleOnlyWake(current, input.requestPayloadByStream?.[stream])
        : current.status === "idle"))) continue;

      // The outstanding revision already carries this request. Leave the row
      // untouched, so its lease, backoff and cursor revision stay valid.
      if (input.coalesceOutstanding && current.requestSeq > current.appliedSeq) {
        results.push({
          stream,
          requestedSeq: current.requestSeq,
          coalesced: true,
          ...(input.includeQueueState ? {
            queueBefore: { requestedSeq: current.requestSeq, appliedSeq: current.appliedSeq },
          } : {}),
        });
        continue;
      }

      const nextRequestSeq = current.requestSeq + 1;
      // An event request is always hint-only; it may narrow that further.
      const rawRequestPayload = input.source === "event"
        ? { ...input.requestPayloadByStream?.[stream], fanslyWsHintOnly: true }
        : input.requestPayloadByStream?.[stream] ?? {};
      const requestPayload = Object.keys(rawRequestPayload).length > 0
        ? { ...rawRequestPayload, revision: nextRequestSeq }
        : rawRequestPayload;
      const leaseExpired = leaseExpiredByStream.get(stream);
      if (leaseExpired === undefined) {
        throw new Error(`Sync stream "${stream}" disappeared while requesting page ${input.pageId}`);
      }
      const queuedStatus = current.status === "retrying" &&
        hasProviderCooldown(current.retryKind, current.retryAt, now)
        ? "retrying"
        : "pending";
      const nextStatus: PageSyncStatus = current.status === "paused"
        ? "paused"
        : current.status === "blocked"
          ? "blocked"
          : current.status === "running" && !leaseExpired
            ? "running"
            : queuedStatus;
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
        ...(input.includeQueueState ? {
          queueBefore: { requestedSeq: current.requestSeq, appliedSeq: current.appliedSeq },
        } : {}),
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
