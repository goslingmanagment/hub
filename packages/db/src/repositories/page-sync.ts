import { and, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  egressEndpoints,
  pageFollows,
  pageSyncCursors,
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
  top_spenders: ["transactions"],
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
  return platform === "fansly"
    ? SYNC_STREAMS.filter((stream) => stream !== "fan_identities")
    : ["light", "transactions", "fan_identities", "dm_conversations", "dm_messages"];
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

  return {
    pageId: page.id,
    stream,
    status: shouldRecover ? "pending" : "idle",
    requestSeq: shouldRecover ? 1 : 0,
    appliedSeq: 0,
    requestSource,
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
  },
) {
  const clauses = [sql`true`];

  if (input?.pageId !== undefined) {
    clauses.push(sql`page_id = ${input.pageId}`);
  }

  if (input?.streams?.length) {
    clauses.push(sql`stream = any(${streamArraySql(input.streams)})`);
  }

  const result = await db.execute<Record<string, unknown>>(sql`
    select page_id as "pageId",
           stream as "stream",
           status as "status",
           request_seq as "requestSeq",
           leased_seq as "leasedSeq",
           applied_seq as "appliedSeq",
           request_source as "requestSource",
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
  },
) {
  const now = input?.now ?? new Date();
  const clauses = [sql`true`];
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

function dependencyMet(streamByName: Map<SyncStream, PageSyncState>, dependency: SyncStream) {
  const row = streamByName.get(dependency);
  return Boolean(row && (row.succeededAt !== null || row.appliedSeq > 0));
}

export async function refreshPageSyncDependencies(
  db: Database,
  input?: {
    pageId?: number;
    now?: Date;
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
    await refreshLockedPageSyncDependencies(database, rows, now);
  });
}

async function refreshLockedPageSyncDependencies(
  db: Database,
  rows: PageSyncState[],
  now: Date,
) {
  const rowsByPage = new Map<number, PageSyncState[]>();
  for (const row of rows) {
    const current = rowsByPage.get(row.pageId) ?? [];
    current.push(row);
    rowsByPage.set(row.pageId, current);
  }

  for (const [pageId, pageRows] of rowsByPage) {
    const streamByName = new Map(pageRows.map((row) => [row.stream, row] as const));
    for (const row of pageRows) {
      const dependencies = (SYNC_STREAM_DEPENDENCIES[row.stream] ?? [])
        .filter((dependency) => streamByName.has(dependency));
      if (dependencies.length === 0) {
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
  now = new Date(),
) {
  const rows = await listPageSyncStates(db);
  const reclaimable = rows.filter((row) =>
    row.leasedSeq !== null &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt.getTime() < now.getTime()
  );

  if (reclaimable.length === 0) {
    return [] as PageSyncState[];
  }

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    for (const row of reclaimable) {
      await database.execute(sql`
        update ${pageSyncStates}
        set status = case
                       when blocker_kind is not null then 'blocked'::page_sync_status
                       when retry_at is not null and retry_at > ${now} then 'retrying'::page_sync_status
                       when request_seq > applied_seq then 'pending'::page_sync_status
                       else 'idle'::page_sync_status
                     end,
            leased_seq = null,
            lease_owner = null,
            lease_token = null,
            lease_heartbeat_at = null,
            lease_expires_at = null,
            updated_at = ${now}
        where page_id = ${row.pageId}
          and stream = ${row.stream}
          and leased_seq is not null
          and lease_token is not null
          and lease_expires_at < ${now}
      `);
    }
  });

  return reclaimable;
}

export async function scheduleDuePageSync(
  db: Database,
  input?: {
    pageId?: number;
    now?: Date;
  },
) {
  const now = input?.now ?? new Date();
  await ensurePageSyncStates(db, {
    pageId: input?.pageId,
    now,
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

      if (row.status === "running" && row.leaseExpiresAt && row.leaseExpiresAt.getTime() >= now.getTime()) {
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
             st.request_source as "requestSource"
      from ${pageSyncStates} st
      inner join ${pages} p on p.id = st.page_id
      left join ${egressEndpoints} ee on ee.platform_account_id = st.page_id
      where st.request_seq > st.applied_seq
        and st.status <> 'paused'
        and st.blocker_kind is null
        and st.leased_seq is null
        and (st.retry_at is null or st.retry_at <= ${now})
    )
    select rs."pageId" as "pageId",
           rs."platform" as "platform",
           max(${streamPriorityBySourceSql('rs."stream"', 'rs."requestSource"')})::int as "priority",
           min(rs."requestedAt") as "requestedAt",
           rs."proxyUrl" as "proxyUrl",
           rs."egressKey" as "egressKey"
    from runnable_streams rs
    group by rs."pageId", rs."platform", rs."proxyUrl", rs."egressKey"
    order by max(${streamPriorityBySourceSql('rs."stream"', 'rs."requestSource"')}) desc,
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
        and st.leased_seq is null
        and (st.retry_at is null or st.retry_at <= ${now})
      order by ${streamPriorityBySourceSql("st.stream", "st.request_source")} desc,
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
          lease_heartbeat_at = ${now},
          lease_expires_at = ${new Date(now.getTime() + input.leaseTtlMs)},
          started_at = ${now},
          updated_at = ${now}
      from candidate
      where st.page_id = candidate."pageId"
        and st.stream = candidate."stream"
        and st.request_seq = candidate."requestSeq"
        and st.status <> 'paused'
        and st.blocker_kind is null
        and st.leased_seq is null
        and (st.retry_at is null or st.retry_at <= ${now})
      returning st.page_id as "pageId",
                st.stream as "stream",
                st.status as "status",
                st.request_seq as "requestSeq",
                st.leased_seq as "leasedSeq",
                st.applied_seq as "appliedSeq",
                st.request_source as "requestSource",
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
    set lease_heartbeat_at = ${now},
        lease_expires_at = ${new Date(now.getTime() + input.leaseTtlMs)},
        updated_at = ${now}
    where page_id = ${input.pageId}
      and stream = ${input.stream}
      and lease_token = ${input.leaseToken}
      and leased_seq is not null
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
  `);

  const applied = (result.rowCount ?? 0) > 0;
  if (applied) {
    await refreshPageSyncDependencies(db, {
      pageId: input.pageId,
      now,
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
    requestSource?: SyncRequestSource | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const retryAt = input.retryAt ?? null;
  const requestSource = input.requestSource ?? null;
  const result = await db.execute(sql`
    update ${pageSyncStates}
    set status = 'pending',
        leased_seq = null,
        progressed_at = coalesce(${input.progressedAt ?? null}, progressed_at),
        finished_at = ${now},
        phase = ${input.phase ?? null},
        work_class = ${input.workClass ?? null},
        progress = ${input.progress ?? {}},
        request_source = coalesce(${requestSource}::sync_request_source, request_source),
        consecutive_failures = 0,
        last_error_code = null,
        last_error_summary = null,
        retry_kind = null,
        retry_at = ${retryAt},
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where page_id = ${input.pageId}
      and stream = ${input.stream}
      and lease_token = ${input.leaseToken}
      and leased_seq = ${input.requestSeq}
  `);

  return (result.rowCount ?? 0) > 0;
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
            blocker_kind = case when blocker_kind = 'auth' then blocker_kind else null end,
            blocker_code = case when blocker_kind = 'auth' then blocker_code else null end,
            blocker_message = case when blocker_kind = 'auth' then blocker_message else null end,
            blocked_at = case when blocker_kind = 'auth' then blocked_at else null end,
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
  },
) {
  const now = input.now ?? new Date();
  const requestedStreams = normalizePageSyncRequestStreams(input.streams);
  const results: Array<{ stream: SyncStream; requestedSeq: number }> = [];

  await ensurePageSyncStates(db, {
    pageId: input.pageId,
    onboarding: input.source === "onboarding",
    now,
  });

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const lockedRows = await listPageSyncStatesInternal(database, { pageId: input.pageId }, { lock: true });
    const lockedRowsByStream = new Map(lockedRows.map((row) => [row.stream, row] as const));

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
      const leaseExpired = current.leasedSeq !== null &&
        current.leaseExpiresAt !== null &&
        current.leaseExpiresAt.getTime() <= now.getTime();
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
    );
  });

  return results;
}
