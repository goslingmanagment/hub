import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  pageFollows,
  platformAccountProxies,
  platformAccounts,
  syncCursors,
  syncOperations,
  syncStreamState,
  syncTasks,
} from "../schema.ts";

type TimestampValue = Date | string | null | undefined;
type NumericValue = number | bigint | null | undefined;

export const SYNC_V2_TASKS = [
  "light",
  "transactions",
  "top_spenders",
  "subscribers",
  "followers",
  "followers_reconcile",
  "dm_conversations",
  "dm_messages",
] as const;

export type SyncV2Task = typeof SYNC_V2_TASKS[number];

export const SYNC_V2_DOMAINS = [
  "connection",
  "financials",
  "audience",
  "messages_live",
  "messages_history",
] as const;

export type SyncV2Domain = typeof SYNC_V2_DOMAINS[number];
export type SyncTaskRuntimeState = "idle" | "queued" | "running" | "retry_wait" | "blocked" | "paused";
export type SyncOperationSource = "scheduled" | "manual" | "onboarding" | "recovery" | "anomaly" | "reset";
export type SyncWorkClass = "live" | "history" | "maintenance";

export interface SyncTaskPolicy {
  task: SyncV2Task;
  domain: SyncV2Domain;
  cadenceSeconds: number;
  basePriority: number;
  taskIndex: number;
  defaultWorkClass: SyncWorkClass;
  queueDelayThresholdMs: number;
  progressStallThresholdMs: number;
  freshnessSlaSeconds: number | null;
}

export interface SyncDomainPolicy {
  domain: SyncV2Domain;
  primaryTasks: SyncV2Task[];
  supportingTasks: SyncV2Task[];
  freshnessSlaSeconds: number | null;
}

export const TASK_DOMAIN_MAP: Record<SyncV2Task, SyncV2Domain> = {
  light: "connection",
  transactions: "financials",
  top_spenders: "financials",
  subscribers: "audience",
  followers: "audience",
  followers_reconcile: "audience",
  dm_conversations: "messages_live",
  dm_messages: "messages_history",
};

export const TASK_POLICY: Record<SyncV2Task, SyncTaskPolicy> = {
  light: {
    task: "light",
    domain: "connection",
    cadenceSeconds: 3600,
    basePriority: 60,
    taskIndex: 1,
    defaultWorkClass: "live",
    queueDelayThresholdMs: 3 * 60_000,
    progressStallThresholdMs: 3 * 60_000,
    freshnessSlaSeconds: 3 * 3600,
  },
  transactions: {
    task: "transactions",
    domain: "financials",
    cadenceSeconds: 3600,
    basePriority: 50,
    taskIndex: 2,
    defaultWorkClass: "live",
    queueDelayThresholdMs: 5 * 60_000,
    progressStallThresholdMs: 5 * 60_000,
    freshnessSlaSeconds: 3 * 3600,
  },
  top_spenders: {
    task: "top_spenders",
    domain: "financials",
    cadenceSeconds: 3600,
    basePriority: 45,
    taskIndex: 3,
    defaultWorkClass: "maintenance",
    queueDelayThresholdMs: 10 * 60_000,
    progressStallThresholdMs: 10 * 60_000,
    freshnessSlaSeconds: null,
  },
  subscribers: {
    task: "subscribers",
    domain: "audience",
    cadenceSeconds: 3600,
    basePriority: 40,
    taskIndex: 4,
    defaultWorkClass: "live",
    queueDelayThresholdMs: 5 * 60_000,
    progressStallThresholdMs: 5 * 60_000,
    freshnessSlaSeconds: 3 * 3600,
  },
  followers: {
    task: "followers",
    domain: "audience",
    cadenceSeconds: 3600,
    basePriority: 35,
    taskIndex: 5,
    defaultWorkClass: "live",
    queueDelayThresholdMs: 5 * 60_000,
    progressStallThresholdMs: 5 * 60_000,
    freshnessSlaSeconds: 3 * 3600,
  },
  followers_reconcile: {
    task: "followers_reconcile",
    domain: "audience",
    cadenceSeconds: 172800,
    basePriority: 34,
    taskIndex: 6,
    defaultWorkClass: "maintenance",
    queueDelayThresholdMs: 30 * 60_000,
    progressStallThresholdMs: 15 * 60_000,
    freshnessSlaSeconds: null,
  },
  dm_conversations: {
    task: "dm_conversations",
    domain: "messages_live",
    cadenceSeconds: 1800,
    basePriority: 30,
    taskIndex: 7,
    defaultWorkClass: "live",
    queueDelayThresholdMs: 5 * 60_000,
    progressStallThresholdMs: 5 * 60_000,
    freshnessSlaSeconds: 3600,
  },
  dm_messages: {
    task: "dm_messages",
    domain: "messages_history",
    cadenceSeconds: 86400,
    basePriority: 25,
    taskIndex: 8,
    defaultWorkClass: "history",
    queueDelayThresholdMs: 15 * 60_000,
    progressStallThresholdMs: 15 * 60_000,
    freshnessSlaSeconds: null,
  },
};

export const DOMAIN_POLICY: Record<SyncV2Domain, SyncDomainPolicy> = {
  connection: {
    domain: "connection",
    primaryTasks: ["light"],
    supportingTasks: [],
    freshnessSlaSeconds: 3 * 3600,
  },
  financials: {
    domain: "financials",
    primaryTasks: ["transactions"],
    supportingTasks: ["top_spenders"],
    freshnessSlaSeconds: 3 * 3600,
  },
  audience: {
    domain: "audience",
    primaryTasks: ["subscribers", "followers"],
    supportingTasks: ["followers_reconcile"],
    freshnessSlaSeconds: 3 * 3600,
  },
  messages_live: {
    domain: "messages_live",
    primaryTasks: ["dm_conversations"],
    supportingTasks: [],
    freshnessSlaSeconds: 3600,
  },
  messages_history: {
    domain: "messages_history",
    primaryTasks: ["dm_messages"],
    supportingTasks: [],
    freshnessSlaSeconds: null,
  },
};

export const TASK_DEPENDENCIES: Partial<Record<SyncV2Task, SyncV2Task[]>> = {
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

const TASK_REQUEST_PRIORITY_BY_SOURCE: Record<SyncOperationSource, Record<SyncV2Task, number>> = {
  scheduled: {
    light: 60,
    transactions: 50,
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
    top_spenders: 85,
    subscribers: 80,
    followers: 75,
    followers_reconcile: 74,
    dm_conversations: 70,
    dm_messages: 65,
  },
};

export interface SyncTaskRow {
  platformAccountId: number;
  task: SyncV2Task;
  status: SyncTaskRuntimeState;
  desiredGeneration: number;
  runningGeneration: number | null;
  appliedGeneration: number;
  scheduleIntervalSeconds: number;
  slotOffsetSeconds: number;
  lastScheduledSlot: number;
  lastRequestedAt: Date | null;
  lastEnqueuedAt: Date | null;
  lastStartedAt: Date | null;
  lastProgressAt: Date | null;
  lastFinishedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  retryClass: string | null;
  retryAt: Date | null;
  blockerType: string | null;
  blockerCode: string | null;
  blockerReason: string | null;
  blockedSince: Date | null;
  currentPhase: string | null;
  currentWorkClass: SyncWorkClass | null;
  progressPayload: Record<string, unknown>;
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

export interface SyncTaskLeaseRow extends SyncTaskRow {
  operationId: number | null;
  operationSource: SyncOperationSource | null;
  requestPayload: Record<string, unknown> | null;
  platform: "fansly" | "onlyfans";
  proxyUrl: string | null;
}

export interface SyncTaskWakeupRow {
  platformAccountId: number;
  platform: "fansly" | "onlyfans";
  priority: number;
  requestedAt: Date | null;
  proxyUrl: string | null;
}

interface LegacySyncStreamSeedRow {
  platformAccountId: number;
  task: SyncV2Task;
  status: "active" | "paused" | "auth_failed" | "disabled";
  cadenceSeconds: number;
  slotOffsetSeconds: number;
  nextDueAt: Date | null;
  desiredGeneration: number;
  appliedGeneration: number;
  desiredAt: Date | null;
  requestPayload: Record<string, unknown> | null;
  retryAt: Date | null;
  lastEnqueuedAt: Date | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
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

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "-infinity") {
      return new Date(0);
    }
    if (normalized === "infinity") {
      return new Date(8_640_000_000_000_000);
    }
    if (normalized.includes("bc")) {
      return new Date(0);
    }
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    if (field === "retryAt") {
      return new Date(0);
    }
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

function asSyncTask(value: string): SyncV2Task {
  if ((SYNC_V2_TASKS as readonly string[]).includes(value)) {
    return value as SyncV2Task;
  }

  throw new Error(`Unsupported sync task "${value}"`);
}

function asLegacySyncTargetStatus(value: unknown, field: string) {
  if (value === "active" || value === "paused" || value === "auth_failed" || value === "disabled") {
    return value;
  }

  throw new Error(`Expected ${field} to be a supported legacy sync status`);
}

function asPlatform(value: unknown, field: string) {
  if (value === "fansly" || value === "onlyfans") {
    return value;
  }

  throw new Error(`Expected ${field} to be a supported platform`);
}

function taskArraySql(tasks: readonly SyncV2Task[]) {
  if (tasks.length === 0) {
    return sql`ARRAY[]::sync_task[]`;
  }

  return sql`ARRAY[${sql.join(tasks.map((task) => sql`${task}::sync_task`), sql`, `)}]::sync_task[]`;
}

function taskOrderSql(columnName: string) {
  return sql.raw(`
    case ${columnName}
      when 'light' then ${TASK_POLICY.light.taskIndex}
      when 'transactions' then ${TASK_POLICY.transactions.taskIndex}
      when 'top_spenders' then ${TASK_POLICY.top_spenders.taskIndex}
      when 'subscribers' then ${TASK_POLICY.subscribers.taskIndex}
      when 'followers' then ${TASK_POLICY.followers.taskIndex}
      when 'followers_reconcile' then ${TASK_POLICY.followers_reconcile.taskIndex}
      when 'dm_conversations' then ${TASK_POLICY.dm_conversations.taskIndex}
      when 'dm_messages' then ${TASK_POLICY.dm_messages.taskIndex}
      else 999
    end
  `);
}

function taskPriorityCaseSql(columnName: string, source: SyncOperationSource) {
  const priorities = TASK_REQUEST_PRIORITY_BY_SOURCE[source];
  return sql.raw(`
    case ${columnName}
      when 'light' then ${priorities.light}
      when 'transactions' then ${priorities.transactions}
      when 'top_spenders' then ${priorities.top_spenders}
      when 'subscribers' then ${priorities.subscribers}
      when 'followers' then ${priorities.followers}
      when 'followers_reconcile' then ${priorities.followers_reconcile}
      when 'dm_conversations' then ${priorities.dm_conversations}
      when 'dm_messages' then ${priorities.dm_messages}
      else 0
    end
  `);
}

function taskPriorityBySourceSql(taskColumnName: string, sourceColumnName: string) {
  const priorityCase = (source: SyncOperationSource) => `
    case ${taskColumnName}
      when 'light' then ${TASK_REQUEST_PRIORITY_BY_SOURCE[source].light}
      when 'transactions' then ${TASK_REQUEST_PRIORITY_BY_SOURCE[source].transactions}
      when 'top_spenders' then ${TASK_REQUEST_PRIORITY_BY_SOURCE[source].top_spenders}
      when 'subscribers' then ${TASK_REQUEST_PRIORITY_BY_SOURCE[source].subscribers}
      when 'followers' then ${TASK_REQUEST_PRIORITY_BY_SOURCE[source].followers}
      when 'followers_reconcile' then ${TASK_REQUEST_PRIORITY_BY_SOURCE[source].followers_reconcile}
      when 'dm_conversations' then ${TASK_REQUEST_PRIORITY_BY_SOURCE[source].dm_conversations}
      when 'dm_messages' then ${TASK_REQUEST_PRIORITY_BY_SOURCE[source].dm_messages}
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

function normalizeSyncTaskRow(row: Record<string, unknown>): SyncTaskRow {
  return {
    platformAccountId: normalizeNumber(row.platformAccountId as NumericValue, "platformAccountId"),
    task: asSyncTask(String(row.task)),
    status: String(row.status) as SyncTaskRuntimeState,
    desiredGeneration: normalizeNumber(row.desiredGeneration as NumericValue, "desiredGeneration"),
    runningGeneration: normalizeNullableNumber(row.runningGeneration as NumericValue, "runningGeneration"),
    appliedGeneration: normalizeNumber(row.appliedGeneration as NumericValue, "appliedGeneration"),
    scheduleIntervalSeconds: normalizeNumber(
      row.scheduleIntervalSeconds as NumericValue,
      "scheduleIntervalSeconds",
    ),
    slotOffsetSeconds: normalizeNumber(row.slotOffsetSeconds as NumericValue, "slotOffsetSeconds"),
    lastScheduledSlot: normalizeNumber(row.lastScheduledSlot as NumericValue, "lastScheduledSlot"),
    lastRequestedAt: normalizeTimestamp(row.lastRequestedAt as TimestampValue, "lastRequestedAt"),
    lastEnqueuedAt: normalizeTimestamp(row.lastEnqueuedAt as TimestampValue, "lastEnqueuedAt"),
    lastStartedAt: normalizeTimestamp(row.lastStartedAt as TimestampValue, "lastStartedAt"),
    lastProgressAt: normalizeTimestamp(row.lastProgressAt as TimestampValue, "lastProgressAt"),
    lastFinishedAt: normalizeTimestamp(row.lastFinishedAt as TimestampValue, "lastFinishedAt"),
    lastSuccessAt: normalizeTimestamp(row.lastSuccessAt as TimestampValue, "lastSuccessAt"),
    lastFailureAt: normalizeTimestamp(row.lastFailureAt as TimestampValue, "lastFailureAt"),
    retryClass: typeof row.retryClass === "string" ? row.retryClass : null,
    retryAt: normalizeTimestamp(row.retryAt as TimestampValue, "retryAt"),
    blockerType: typeof row.blockerType === "string" ? row.blockerType : null,
    blockerCode: typeof row.blockerCode === "string" ? row.blockerCode : null,
    blockerReason: typeof row.blockerReason === "string" ? row.blockerReason : null,
    blockedSince: normalizeTimestamp(row.blockedSince as TimestampValue, "blockedSince"),
    currentPhase: typeof row.currentPhase === "string" ? row.currentPhase : null,
    currentWorkClass: typeof row.currentWorkClass === "string"
      ? row.currentWorkClass as SyncWorkClass
      : null,
    progressPayload: normalizeRecord(row.progressPayload, "progressPayload"),
    leaseOwner: typeof row.leaseOwner === "string" ? row.leaseOwner : null,
    leaseToken: typeof row.leaseToken === "string" ? row.leaseToken : null,
    leaseHeartbeatAt: normalizeTimestamp(row.leaseHeartbeatAt as TimestampValue, "leaseHeartbeatAt"),
    leaseExpiresAt: normalizeTimestamp(row.leaseExpiresAt as TimestampValue, "leaseExpiresAt"),
    consecutiveFailures: normalizeNumber(
      row.consecutiveFailures as NumericValue,
      "consecutiveFailures",
    ),
    lastErrorCode: typeof row.lastErrorCode === "string" ? row.lastErrorCode : null,
    lastErrorSummary: typeof row.lastErrorSummary === "string" ? row.lastErrorSummary : null,
    createdAt: normalizeTimestamp(row.createdAt as TimestampValue, "createdAt") ?? new Date(0),
    updatedAt: normalizeTimestamp(row.updatedAt as TimestampValue, "updatedAt") ?? new Date(0),
  };
}

function normalizeSyncTaskLeaseRow(row: Record<string, unknown>): SyncTaskLeaseRow {
  return {
    ...normalizeSyncTaskRow(row),
    operationId: normalizeNullableNumber(row.operationId as NumericValue, "operationId"),
    operationSource: typeof row.operationSource === "string"
      ? row.operationSource as SyncOperationSource
      : null,
    requestPayload: row.requestPayload === null || row.requestPayload === undefined
      ? null
      : normalizeRecord(row.requestPayload, "requestPayload"),
    platform: asPlatform(row.platform, "platform"),
    proxyUrl: typeof row.proxyUrl === "string" ? row.proxyUrl : null,
  };
}

interface SyncTaskLegacyMirrorRow extends SyncTaskRow {
  operationSource: SyncOperationSource | null;
  requestPayload: Record<string, unknown> | null;
}

function computeLegacyNextDueAt(task: SyncTaskRow) {
  return new Date(((task.lastScheduledSlot + 1) * task.scheduleIntervalSeconds + task.slotOffsetSeconds) * 1000);
}

function mapOperationSourceToLegacyReason(source: SyncOperationSource | null) {
  if (source === "manual" || source === "reset") {
    return "manual" as const;
  }

  return source ?? "scheduled";
}

function mapSyncTaskToLegacyStatus(task: SyncTaskRow) {
  if (task.status === "paused") {
    return "paused" as const;
  }

  if (task.status === "blocked" && task.blockerType === "auth") {
    return "auth_failed" as const;
  }

  return "active" as const;
}

function normalizeSyncTaskLegacyMirrorRow(row: Record<string, unknown>): SyncTaskLegacyMirrorRow {
  return {
    ...normalizeSyncTaskRow(row),
    operationSource: typeof row.operationSource === "string"
      ? row.operationSource as SyncOperationSource
      : null,
    requestPayload: row.requestPayload === null || row.requestPayload === undefined
      ? null
      : normalizeRecord(row.requestPayload, "requestPayload"),
  };
}

async function listSyncTaskLegacyMirrorRows(
  db: Database,
  input?: {
    platformAccountId?: number;
    tasks?: SyncV2Task[];
  },
) {
  const clauses = [sql`true`];

  if (input?.platformAccountId !== undefined) {
    clauses.push(sql`st.platform_account_id = ${input.platformAccountId}`);
  }

  if (input?.tasks?.length) {
    clauses.push(sql`st.task = any(${taskArraySql(input.tasks)})`);
  }

  const result = await db.execute<Record<string, unknown>>(sql`
    select st.platform_account_id as "platformAccountId",
           st.task as "task",
           st.status as "status",
           st.desired_generation as "desiredGeneration",
           st.running_generation as "runningGeneration",
           st.applied_generation as "appliedGeneration",
           st.schedule_interval_seconds as "scheduleIntervalSeconds",
           st.slot_offset_seconds as "slotOffsetSeconds",
           st.last_scheduled_slot as "lastScheduledSlot",
           st.last_requested_at as "lastRequestedAt",
           st.last_enqueued_at as "lastEnqueuedAt",
           st.last_started_at as "lastStartedAt",
           st.last_progress_at as "lastProgressAt",
           st.last_finished_at as "lastFinishedAt",
           st.last_success_at as "lastSuccessAt",
           st.last_failure_at as "lastFailureAt",
           st.retry_class as "retryClass",
           st.retry_at as "retryAt",
           st.blocker_type as "blockerType",
           st.blocker_code as "blockerCode",
           st.blocker_reason as "blockerReason",
           st.blocked_since as "blockedSince",
           st.current_phase as "currentPhase",
           st.current_work_class as "currentWorkClass",
           st.progress_payload as "progressPayload",
           st.lease_owner as "leaseOwner",
           st.lease_token as "leaseToken",
           st.lease_heartbeat_at as "leaseHeartbeatAt",
           st.lease_expires_at as "leaseExpiresAt",
           st.consecutive_failures as "consecutiveFailures",
           st.last_error_code as "lastErrorCode",
           st.last_error_summary as "lastErrorSummary",
           st.created_at as "createdAt",
           st.updated_at as "updatedAt",
           so.source as "operationSource",
           so.request_payload as "requestPayload"
    from sync_tasks st
    left join ${syncOperations} so
      on so.platform_account_id = st.platform_account_id
     and so.task = st.task
     and so.generation = st.desired_generation
    where ${and(...clauses)}
    order by st.platform_account_id asc, ${taskOrderSql("st.task")} asc
  `);

  return result.rows.map((row) => normalizeSyncTaskLegacyMirrorRow(row));
}

async function mirrorLegacySyncStreamState(
  db: Database,
  input?: {
    platformAccountId?: number;
    tasks?: SyncV2Task[];
  },
) {
  const rows = await listSyncTaskLegacyMirrorRows(db, input);
  if (rows.length === 0) {
    return;
  }

  await db.insert(syncStreamState).values(rows.map((row) => ({
    platformAccountId: row.platformAccountId,
    stream: row.task,
    status: mapSyncTaskToLegacyStatus(row),
    cadenceSeconds: row.scheduleIntervalSeconds,
    slotOffsetSeconds: row.slotOffsetSeconds,
    nextDueAt: computeLegacyNextDueAt(row),
    basePriority: TASK_POLICY[row.task].basePriority,
    effectivePriority: resolveSyncTaskPriority(row.task, row.operationSource ?? "scheduled"),
    pendingReason: mapOperationSourceToLegacyReason(row.operationSource),
    desiredRevision: row.desiredGeneration,
    satisfiedRevision: row.appliedGeneration,
    desiredAt: row.lastRequestedAt,
    requestPayload: row.requestPayload,
    backoffUntil: row.retryAt ?? new Date(0),
    lastEnqueuedAt: row.lastEnqueuedAt,
    lastStartedAt: row.lastStartedAt,
    lastFinishedAt: row.lastFinishedAt,
    lastSucceededAt: row.lastSuccessAt,
    lastFailedAt: row.lastFailureAt,
    consecutiveFailures: row.consecutiveFailures,
    lastErrorCode: row.lastErrorCode,
    lastErrorSummary: row.lastErrorSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))).onConflictDoUpdate({
    target: [syncStreamState.platformAccountId, syncStreamState.stream],
    set: {
      status: sql`excluded.status`,
      cadenceSeconds: sql`excluded.cadence_seconds`,
      slotOffsetSeconds: sql`excluded.slot_offset_seconds`,
      nextDueAt: sql`excluded.next_due_at`,
      basePriority: sql`excluded.base_priority`,
      effectivePriority: sql`excluded.effective_priority`,
      pendingReason: sql`excluded.pending_reason`,
      desiredRevision: sql`excluded.desired_revision`,
      satisfiedRevision: sql`excluded.satisfied_revision`,
      desiredAt: sql`excluded.desired_at`,
      requestPayload: sql`excluded.request_payload`,
      backoffUntil: sql`excluded.backoff_until`,
      lastEnqueuedAt: sql`excluded.last_enqueued_at`,
      lastStartedAt: sql`excluded.last_started_at`,
      lastFinishedAt: sql`excluded.last_finished_at`,
      lastSucceededAt: sql`excluded.last_succeeded_at`,
      lastFailedAt: sql`excluded.last_failed_at`,
      consecutiveFailures: sql`excluded.consecutive_failures`,
      lastErrorCode: sql`excluded.last_error_code`,
      lastErrorSummary: sql`excluded.last_error_summary`,
      updatedAt: sql`excluded.updated_at`,
    },
  });
}

export function getSyncTasksForPlatform(platform: "fansly" | "onlyfans"): SyncV2Task[] {
  return platform === "fansly"
    ? [...SYNC_V2_TASKS]
    : ["light", "transactions"];
}

export function resolveSyncTaskPriority(task: SyncV2Task, source: SyncOperationSource) {
  return TASK_REQUEST_PRIORITY_BY_SOURCE[source][task];
}

export function computeSyncTaskSlotOffsetSeconds(
  platformAccountId: number,
  task: SyncV2Task,
) {
  const policy = TASK_POLICY[task];
  return Number(
    ((BigInt(platformAccountId) * 2654435761n) + (BigInt(policy.taskIndex) * 2246822519n)) %
      BigInt(policy.cadenceSeconds),
  );
}

export function computeCurrentSyncTaskSlot(
  now: Date,
  scheduleIntervalSeconds: number,
  slotOffsetSeconds: number,
) {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return Math.floor((nowSeconds - slotOffsetSeconds) / scheduleIntervalSeconds);
}

function computeTrustedTaskTimestamp(
  task: SyncV2Task,
  page: {
    lastLightSyncAt: Date | null;
    lastFollowerSyncAt: Date | null;
  },
) {
  if (task === "light" || task === "transactions" || task === "subscribers") {
    return page.lastLightSyncAt;
  }

  if (task === "followers" || task === "followers_reconcile") {
    return page.lastFollowerSyncAt;
  }

  return null;
}

function computeLastScheduledSlotFromNextDueAt(
  nextDueAt: Date | null,
  scheduleIntervalSeconds: number,
  slotOffsetSeconds: number,
  now: Date,
) {
  if (!nextDueAt) {
    return computeCurrentSyncTaskSlot(now, scheduleIntervalSeconds, slotOffsetSeconds);
  }

  return Math.max(
    -1,
    Math.floor((Math.floor(nextDueAt.getTime() / 1000) - slotOffsetSeconds) / scheduleIntervalSeconds) - 1,
  );
}

function inferRetryClassFromLegacyRow(
  row: LegacySyncStreamSeedRow,
  now: Date,
) {
  if (!row.retryAt || row.retryAt.getTime() <= now.getTime()) {
    return null;
  }

  const lowerCode = row.lastErrorCode?.toLowerCase() ?? "";
  const lowerSummary = row.lastErrorSummary?.toLowerCase() ?? "";
  if (lowerCode.includes("429") || lowerSummary.includes("429")) {
    return "rate_limit";
  }
  if (lowerCode.startsWith("http_5") || lowerSummary.includes("timeout")) {
    return "provider_5xx";
  }

  return "transient_network";
}

function normalizeLegacySyncStreamSeedRow(row: Record<string, unknown>): LegacySyncStreamSeedRow {
  return {
    platformAccountId: normalizeNumber(row.platformAccountId as NumericValue, "platformAccountId"),
    task: asSyncTask(String(row.task ?? "")),
    status: asLegacySyncTargetStatus(row.status, "status"),
    cadenceSeconds: normalizeNumber(row.cadenceSeconds as NumericValue, "cadenceSeconds"),
    slotOffsetSeconds: normalizeNumber(row.slotOffsetSeconds as NumericValue, "slotOffsetSeconds"),
    nextDueAt: normalizeTimestamp(row.nextDueAt as TimestampValue, "nextDueAt"),
    desiredGeneration: normalizeNumber(row.desiredGeneration as NumericValue, "desiredGeneration"),
    appliedGeneration: normalizeNumber(row.appliedGeneration as NumericValue, "appliedGeneration"),
    desiredAt: normalizeTimestamp(row.desiredAt as TimestampValue, "desiredAt"),
    requestPayload: row.requestPayload === null || row.requestPayload === undefined
      ? null
      : normalizeRecord(row.requestPayload, "requestPayload"),
    retryAt: normalizeTimestamp(row.retryAt as TimestampValue, "retryAt"),
    lastEnqueuedAt: normalizeTimestamp(row.lastEnqueuedAt as TimestampValue, "lastEnqueuedAt"),
    lastStartedAt: normalizeTimestamp(row.lastStartedAt as TimestampValue, "lastStartedAt"),
    lastFinishedAt: normalizeTimestamp(row.lastFinishedAt as TimestampValue, "lastFinishedAt"),
    lastSuccessAt: normalizeTimestamp(row.lastSuccessAt as TimestampValue, "lastSuccessAt"),
    lastFailureAt: normalizeTimestamp(row.lastFailureAt as TimestampValue, "lastFailureAt"),
    consecutiveFailures: normalizeNumber(row.consecutiveFailures as NumericValue, "consecutiveFailures"),
    lastErrorCode: typeof row.lastErrorCode === "string" ? row.lastErrorCode : null,
    lastErrorSummary: typeof row.lastErrorSummary === "string" ? row.lastErrorSummary : null,
    createdAt: normalizeTimestamp(row.createdAt as TimestampValue, "createdAt") ?? new Date(),
    updatedAt: normalizeTimestamp(row.updatedAt as TimestampValue, "updatedAt") ?? new Date(),
  };
}

function buildSeedSyncTaskValue(
  page: {
    platformAccountId: number;
    platform: "fansly" | "onlyfans";
    lastLightSyncAt: Date | null;
    lastFollowerSyncAt: Date | null;
    followerCount: number;
    activeFollowerCount: number;
  },
  task: SyncV2Task,
  now: Date,
  onboarding: boolean,
): typeof syncTasks.$inferInsert {
  const policy = TASK_POLICY[task];
  const slotOffsetSeconds = computeSyncTaskSlotOffsetSeconds(page.platformAccountId, task);
  const currentSlot = computeCurrentSyncTaskSlot(now, policy.cadenceSeconds, slotOffsetSeconds);
  const trustedAt = computeTrustedTaskTimestamp(task, page);
  const shouldRecover = onboarding && task !== "followers_reconcile";

  return {
    platformAccountId: page.platformAccountId,
    task,
    status: shouldRecover ? "queued" : "idle",
    desiredGeneration: shouldRecover ? 1 : 0,
    appliedGeneration: 0,
    scheduleIntervalSeconds: policy.cadenceSeconds,
    slotOffsetSeconds,
    lastScheduledSlot: currentSlot,
    lastRequestedAt: shouldRecover ? now : null,
    lastSuccessAt: shouldRecover ? null : trustedAt,
    lastFinishedAt: shouldRecover ? null : trustedAt,
    lastProgressAt: shouldRecover ? null : trustedAt,
    currentWorkClass: policy.defaultWorkClass,
    progressPayload: {},
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function buildSeedSyncTaskValueFromLegacy(
  page: {
    platformAccountId: number;
    platform: "fansly" | "onlyfans";
    lastLightSyncAt: Date | null;
    lastFollowerSyncAt: Date | null;
    followerCount: number;
    activeFollowerCount: number;
  },
  legacyRow: LegacySyncStreamSeedRow,
  now: Date,
): typeof syncTasks.$inferInsert {
  const policy = TASK_POLICY[legacyRow.task];
  const slotOffsetSeconds = computeSyncTaskSlotOffsetSeconds(page.platformAccountId, legacyRow.task);
  const trustedAt = computeTrustedTaskTimestamp(legacyRow.task, page);
  const retryClass = inferRetryClassFromLegacyRow(legacyRow, now);
  const hasPendingGeneration = legacyRow.desiredGeneration > legacyRow.appliedGeneration;
  const looksRunning = hasPendingGeneration &&
    legacyRow.lastStartedAt !== null &&
    (legacyRow.lastFinishedAt === null || legacyRow.lastStartedAt.getTime() > legacyRow.lastFinishedAt.getTime());

  let status: SyncTaskRuntimeState = "idle";
  let blockerType: string | null = null;
  let blockerCode: string | null = null;
  let blockerReason: string | null = null;
  let blockedSince: Date | null = null;

  switch (legacyRow.status) {
    case "paused":
    case "disabled":
      status = "paused";
      break;
    case "auth_failed":
      status = "blocked";
      blockerType = "auth";
      blockerCode = "credentials_invalid";
      blockerReason = legacyRow.lastErrorSummary ?? "Credentials must be refreshed before sync can continue.";
      blockedSince = legacyRow.lastFailureAt ?? legacyRow.updatedAt;
      break;
    case "active":
    default:
      if (looksRunning) {
        status = "running";
      } else if (retryClass) {
        status = "retry_wait";
      } else if (hasPendingGeneration) {
        status = "queued";
      }
      break;
  }

  return {
    platformAccountId: page.platformAccountId,
    task: legacyRow.task,
    status,
    desiredGeneration: legacyRow.desiredGeneration,
    runningGeneration: status === "running" ? legacyRow.desiredGeneration : null,
    appliedGeneration: legacyRow.appliedGeneration,
    scheduleIntervalSeconds: policy.cadenceSeconds,
    slotOffsetSeconds,
    lastScheduledSlot: computeLastScheduledSlotFromNextDueAt(
      legacyRow.nextDueAt,
      policy.cadenceSeconds,
      slotOffsetSeconds,
      now,
    ),
    lastRequestedAt: hasPendingGeneration
      ? legacyRow.desiredAt ?? legacyRow.lastEnqueuedAt ?? legacyRow.lastStartedAt ?? legacyRow.updatedAt
      : null,
    lastEnqueuedAt: legacyRow.lastEnqueuedAt,
    lastStartedAt: legacyRow.lastStartedAt,
    lastProgressAt: legacyRow.lastFinishedAt ??
      legacyRow.lastStartedAt ??
      legacyRow.lastSuccessAt ??
      legacyRow.lastFailureAt ??
      trustedAt,
    lastFinishedAt: legacyRow.lastFinishedAt ?? legacyRow.lastSuccessAt ?? legacyRow.lastFailureAt ?? trustedAt,
    lastSuccessAt: legacyRow.lastSuccessAt ?? trustedAt,
    lastFailureAt: legacyRow.lastFailureAt,
    retryClass,
    retryAt: retryClass ? legacyRow.retryAt : null,
    blockerType,
    blockerCode,
    blockerReason,
    blockedSince,
    currentPhase: null,
    currentWorkClass: policy.defaultWorkClass,
    progressPayload: legacyRow.requestPayload ?? {},
    consecutiveFailures: legacyRow.consecutiveFailures,
    lastErrorCode: legacyRow.lastErrorCode,
    lastErrorSummary: legacyRow.lastErrorSummary,
    createdAt: legacyRow.createdAt,
    updatedAt: legacyRow.updatedAt,
  };
}

export async function listSyncTaskRows(
  db: Database,
  input?: {
    platformAccountId?: number;
    tasks?: SyncV2Task[];
  },
) {
  const clauses = [sql`true`];

  if (input?.platformAccountId !== undefined) {
    clauses.push(sql`platform_account_id = ${input.platformAccountId}`);
  }

  if (input?.tasks?.length) {
    clauses.push(sql`task = any(${taskArraySql(input.tasks)})`);
  }

  const result = await db.execute<Record<string, unknown>>(sql`
    select platform_account_id as "platformAccountId",
           task as "task",
           status as "status",
           desired_generation as "desiredGeneration",
           running_generation as "runningGeneration",
           applied_generation as "appliedGeneration",
           schedule_interval_seconds as "scheduleIntervalSeconds",
           slot_offset_seconds as "slotOffsetSeconds",
           last_scheduled_slot as "lastScheduledSlot",
           last_requested_at as "lastRequestedAt",
           last_enqueued_at as "lastEnqueuedAt",
           last_started_at as "lastStartedAt",
           last_progress_at as "lastProgressAt",
           last_finished_at as "lastFinishedAt",
           last_success_at as "lastSuccessAt",
           last_failure_at as "lastFailureAt",
           retry_class as "retryClass",
           retry_at as "retryAt",
           blocker_type as "blockerType",
           blocker_code as "blockerCode",
           blocker_reason as "blockerReason",
           blocked_since as "blockedSince",
           current_phase as "currentPhase",
           current_work_class as "currentWorkClass",
           progress_payload as "progressPayload",
           lease_owner as "leaseOwner",
           lease_token as "leaseToken",
           lease_heartbeat_at as "leaseHeartbeatAt",
           lease_expires_at as "leaseExpiresAt",
           consecutive_failures as "consecutiveFailures",
           last_error_code as "lastErrorCode",
           last_error_summary as "lastErrorSummary",
           created_at as "createdAt",
           updated_at as "updatedAt"
    from sync_tasks
    where ${and(...clauses)}
    order by platform_account_id asc, ${taskOrderSql("task")} asc
  `);

  return result.rows.map((row) => normalizeSyncTaskRow(row));
}

export async function getSyncTaskRow(
  db: Database,
  platformAccountId: number,
  task: SyncV2Task,
) {
  const rows = await listSyncTaskRows(db, {
    platformAccountId,
    tasks: [task],
  });

  return rows[0] ?? null;
}

export async function ensureSyncTaskRows(
  db: Database,
  input?: {
    platformAccountId?: number;
    onboarding?: boolean;
    now?: Date;
  },
) {
  const now = input?.now ?? new Date();
  const clauses = [sql`true`];
  if (input?.platformAccountId !== undefined) {
    clauses.push(sql`pa.id = ${input.platformAccountId}`);
  }

  const pages = await db.execute<{
    platformAccountId: NumericValue;
    platform: unknown;
    lastLightSyncAt: TimestampValue;
    lastFollowerSyncAt: TimestampValue;
    followerCount: NumericValue;
    activeFollowerCount: NumericValue;
  }>(sql`
    select pa.id as "platformAccountId",
           pa.platform as "platform",
           pa.last_light_sync_at as "lastLightSyncAt",
           pa.last_follower_sync_at as "lastFollowerSyncAt",
           pa.follower_count as "followerCount",
           coalesce((
             select count(*)::int
             from ${pageFollows} pf
             where pf.platform_account_id = pa.id
               and pf.is_active = true
           ), 0)::int as "activeFollowerCount"
    from ${platformAccounts} pa
    where ${and(...clauses)}
    order by pa.id asc
  `);

  if (pages.rows.length === 0) {
    return [] as SyncTaskRow[];
  }

  const normalizedPages: Array<{
    platformAccountId: number;
    platform: "fansly" | "onlyfans";
    lastLightSyncAt: Date | null;
    lastFollowerSyncAt: Date | null;
    followerCount: number;
    activeFollowerCount: number;
  }> = pages.rows.map((row) => ({
    platformAccountId: normalizeNumber(row.platformAccountId, "platformAccountId"),
    platform: asPlatform(row.platform, "platform"),
    lastLightSyncAt: normalizeTimestamp(row.lastLightSyncAt, "lastLightSyncAt"),
    lastFollowerSyncAt: normalizeTimestamp(row.lastFollowerSyncAt, "lastFollowerSyncAt"),
    followerCount: row.followerCount === null || row.followerCount === undefined
      ? 0
      : normalizeNumber(row.followerCount, "followerCount"),
    activeFollowerCount: normalizeNumber(row.activeFollowerCount, "activeFollowerCount"),
  }));

  const existingRows = await listSyncTaskRows(
    db,
    input?.platformAccountId !== undefined ? { platformAccountId: input.platformAccountId } : undefined,
  );
  const existingKeys = new Set(existingRows.map((row) => `${row.platformAccountId}:${row.task}`));
  const legacyRows = normalizedPages.length === 0
    ? []
    : (await db.select({
      platformAccountId: syncStreamState.platformAccountId,
      task: syncStreamState.stream,
      status: syncStreamState.status,
      cadenceSeconds: syncStreamState.cadenceSeconds,
      slotOffsetSeconds: syncStreamState.slotOffsetSeconds,
      nextDueAt: syncStreamState.nextDueAt,
      desiredGeneration: syncStreamState.desiredRevision,
      appliedGeneration: syncStreamState.satisfiedRevision,
      desiredAt: syncStreamState.desiredAt,
      requestPayload: syncStreamState.requestPayload,
      retryAt: syncStreamState.backoffUntil,
      lastEnqueuedAt: syncStreamState.lastEnqueuedAt,
      lastStartedAt: syncStreamState.lastStartedAt,
      lastFinishedAt: syncStreamState.lastFinishedAt,
      lastSuccessAt: syncStreamState.lastSucceededAt,
      lastFailureAt: syncStreamState.lastFailedAt,
      consecutiveFailures: syncStreamState.consecutiveFailures,
      lastErrorCode: syncStreamState.lastErrorCode,
      lastErrorSummary: syncStreamState.lastErrorSummary,
      createdAt: syncStreamState.createdAt,
      updatedAt: syncStreamState.updatedAt,
    }).from(syncStreamState).where(
      inArray(
        syncStreamState.platformAccountId,
        normalizedPages.map((page) => page.platformAccountId),
      ),
    )).map((row) => normalizeLegacySyncStreamSeedRow(row as Record<string, unknown>));
  const legacyRowsByKey = new Map<string, LegacySyncStreamSeedRow>(
    legacyRows.map((row) => [`${row.platformAccountId}:${row.task}`, row] as const),
  );
  const values = normalizedPages.flatMap((page) =>
    getSyncTasksForPlatform(page.platform).flatMap((task) => {
      const key = `${page.platformAccountId}:${task}`;
      if (existingKeys.has(key)) {
        return [];
      }

      const legacyRow = legacyRowsByKey.get(key);
      return [legacyRow
        ? buildSeedSyncTaskValueFromLegacy(page, legacyRow, now)
        : buildSeedSyncTaskValue(page, task, now, input?.onboarding ?? false)];
    })
  );

  if (values.length > 0) {
    await db.insert(syncTasks).values(values).onConflictDoNothing();
  }

  const refreshedRows = await listSyncTaskRows(
    db,
    input?.platformAccountId !== undefined ? { platformAccountId: input.platformAccountId } : undefined,
  );
  const pageById = new Map(normalizedPages.map((page) => [page.platformAccountId, page]));

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    for (const row of refreshedRows) {
      const page = pageById.get(row.platformAccountId);
      if (!page) {
        continue;
      }

      const policy = TASK_POLICY[row.task];
      const slotOffsetSeconds = computeSyncTaskSlotOffsetSeconds(row.platformAccountId, row.task);
      if (
        row.scheduleIntervalSeconds === policy.cadenceSeconds &&
        row.slotOffsetSeconds === slotOffsetSeconds
      ) {
        continue;
      }

      await database.execute(sql`
        update sync_tasks
        set schedule_interval_seconds = ${policy.cadenceSeconds},
            slot_offset_seconds = ${slotOffsetSeconds},
            updated_at = ${now}
        where platform_account_id = ${row.platformAccountId}
          and task = ${row.task}
      `);
    }
  });
  await mirrorLegacySyncStreamState(
    db,
    input?.platformAccountId !== undefined ? { platformAccountId: input.platformAccountId } : undefined,
  );

  return listSyncTaskRows(
    db,
    input?.platformAccountId !== undefined ? { platformAccountId: input.platformAccountId } : undefined,
  );
}

function dependencyMet(taskByName: Map<SyncV2Task, SyncTaskRow>, dependency: SyncV2Task) {
  const row = taskByName.get(dependency);
  return Boolean(row && (row.lastSuccessAt !== null || row.appliedGeneration > 0));
}

export async function refreshSyncTaskDependencies(
  db: Database,
  input?: {
    platformAccountId?: number;
    now?: Date;
  },
) {
  const now = input?.now ?? new Date();
  const rows = await listSyncTaskRows(db, input?.platformAccountId !== undefined
    ? { platformAccountId: input.platformAccountId }
    : undefined);
  const rowsByPage = new Map<number, SyncTaskRow[]>();
  for (const row of rows) {
    const current = rowsByPage.get(row.platformAccountId) ?? [];
    current.push(row);
    rowsByPage.set(row.platformAccountId, current);
  }

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    for (const [platformAccountId, taskRows] of rowsByPage) {
      const taskByName = new Map(taskRows.map((row) => [row.task, row] satisfies [SyncV2Task, SyncTaskRow]));
      for (const row of taskRows) {
        const dependencies = TASK_DEPENDENCIES[row.task] ?? [];
        if (dependencies.length === 0) {
          continue;
        }

        const unmet = dependencies.filter((dependency) => !dependencyMet(taskByName, dependency));
        if (unmet.length > 0) {
          const shouldBlock = row.status !== "paused" && row.status !== "running" &&
            (row.desiredGeneration > row.appliedGeneration || row.status === "queued" || row.status === "retry_wait");
          if (!shouldBlock) {
            continue;
          }

          await database.execute(sql`
            update sync_tasks
            set status = 'blocked',
                blocker_type = 'dependency',
                blocker_code = 'unmet_dependency',
                blocker_reason = ${`Waiting for ${unmet.join(", ")}`},
                blocked_since = coalesce(blocked_since, ${now}),
                retry_at = null,
                retry_class = null,
                updated_at = ${now}
            where platform_account_id = ${platformAccountId}
              and task = ${row.task}
          `);
          continue;
        }

        if (row.blockerType !== "dependency") {
          continue;
        }

        const nextStatus: SyncTaskRuntimeState = row.desiredGeneration > row.appliedGeneration
          ? "queued"
          : "idle";
        await database.execute(sql`
          update sync_tasks
          set status = ${nextStatus}::sync_task_status,
              blocker_type = null,
              blocker_code = null,
              blocker_reason = null,
              blocked_since = null,
              updated_at = ${now}
          where platform_account_id = ${platformAccountId}
            and task = ${row.task}
        `);
      }
    }
  });

  await mirrorLegacySyncStreamState(
    db,
    input?.platformAccountId !== undefined ? { platformAccountId: input.platformAccountId } : undefined,
  );
}

export async function reclaimExpiredSyncTasks(
  db: Database,
  now = new Date(),
) {
  const rows = await listSyncTaskRows(db);
  const reclaimable = rows.filter((row) =>
    row.status === "running" &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt.getTime() < now.getTime()
  );

  if (reclaimable.length === 0) {
    return [] as SyncTaskRow[];
  }

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    for (const row of reclaimable) {
      const nextStatus: SyncTaskRuntimeState = row.blockerType
        ? "blocked"
        : row.retryAt && row.retryAt.getTime() > now.getTime()
          ? "retry_wait"
          : row.desiredGeneration > row.appliedGeneration
            ? "queued"
            : "idle";

      await database.execute(sql`
        update sync_tasks
        set status = ${nextStatus}::sync_task_status,
            running_generation = null,
            lease_owner = null,
            lease_token = null,
            lease_heartbeat_at = null,
            lease_expires_at = null,
            updated_at = ${now}
        where platform_account_id = ${row.platformAccountId}
          and task = ${row.task}
          and status = 'running'
          and lease_expires_at < ${now}
      `);
    }
  });

  await mirrorLegacySyncStreamState(db);

  return reclaimable;
}

export async function scheduleDueSyncTasks(
  db: Database,
  input?: {
    platformAccountId?: number;
    now?: Date;
  },
) {
  const now = input?.now ?? new Date();
  await ensureSyncTaskRows(db, {
    platformAccountId: input?.platformAccountId,
    now,
  });
  await reclaimExpiredSyncTasks(db, now);

  const rows = await listSyncTaskRows(
    db,
    input?.platformAccountId !== undefined ? { platformAccountId: input.platformAccountId } : undefined,
  );

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    for (const row of rows) {
      if (row.status === "paused") {
        continue;
      }

      if (row.status === "blocked" && row.blockerType !== "dependency") {
        continue;
      }

      if (row.status === "running" && row.leaseExpiresAt && row.leaseExpiresAt.getTime() >= now.getTime()) {
        continue;
      }

      if (row.status === "retry_wait" && row.retryAt && row.retryAt.getTime() > now.getTime()) {
        continue;
      }

      if (row.desiredGeneration > row.appliedGeneration) {
        if (row.status !== "blocked") {
          await database.execute(sql`
            update sync_tasks
            set status = 'queued',
                retry_at = null,
                retry_class = null,
                updated_at = ${now}
            where platform_account_id = ${row.platformAccountId}
              and task = ${row.task}
          `);
        }
        continue;
      }

      const currentSlot = computeCurrentSyncTaskSlot(
        now,
        row.scheduleIntervalSeconds,
        row.slotOffsetSeconds,
      );
      if (currentSlot <= row.lastScheduledSlot) {
        continue;
      }

      const nextGeneration = row.desiredGeneration + 1;
      await database.insert(syncOperations).values({
        platformAccountId: row.platformAccountId,
        task: row.task,
        generation: nextGeneration,
        source: "scheduled",
        requestedByActor: "scheduler",
        requestPayload: {},
        requestedAt: now,
      }).onConflictDoNothing();

      await database.execute(sql`
        update sync_tasks
        set desired_generation = ${nextGeneration},
            last_scheduled_slot = ${currentSlot},
            last_requested_at = ${now},
            status = 'queued',
            updated_at = ${now}
        where platform_account_id = ${row.platformAccountId}
          and task = ${row.task}
          and desired_generation = ${row.desiredGeneration}
          and applied_generation = ${row.appliedGeneration}
      `);
    }
  });

  await mirrorLegacySyncStreamState(
    db,
    input?.platformAccountId !== undefined ? { platformAccountId: input.platformAccountId } : undefined,
  );

  await refreshSyncTaskDependencies(db, {
    platformAccountId: input?.platformAccountId,
    now,
  });

  return listSyncTaskRows(
    db,
    input?.platformAccountId !== undefined ? { platformAccountId: input.platformAccountId } : undefined,
  );
}

export async function listRunnableSyncPagesV2(
  db: Database,
  now = new Date(),
) {
  const result = await db.execute<Record<string, unknown>>(sql`
    with runnable_tasks as (
      select st.platform_account_id as "platformAccountId",
             pa.platform as "platform",
             pap.url as "proxyUrl",
             st.task as "task",
             st.last_requested_at as "lastRequestedAt",
             so.source as "operationSource"
      from sync_tasks st
      inner join ${platformAccounts} pa on pa.id = st.platform_account_id
      left join ${platformAccountProxies} pap on pap.platform_account_id = st.platform_account_id
      left join ${syncOperations} so
        on so.platform_account_id = st.platform_account_id
       and so.task = st.task
       and so.generation = st.desired_generation
      where st.desired_generation > st.applied_generation
        and (
          st.status = 'queued'
          or (st.status = 'retry_wait' and st.retry_at is not null and st.retry_at <= ${now})
        )
    )
    select rt."platformAccountId" as "platformAccountId",
           rt."platform" as "platform",
           max(${taskPriorityBySourceSql('rt."task"', 'rt."operationSource"')})::int as "priority",
           min(rt."lastRequestedAt") as "requestedAt",
           rt."proxyUrl" as "proxyUrl"
    from runnable_tasks rt
    group by rt."platformAccountId", rt."platform", rt."proxyUrl"
    order by max(${taskPriorityBySourceSql('rt."task"', 'rt."operationSource"')}) desc,
             min(rt."lastRequestedAt") asc nulls last,
             rt."platformAccountId" asc
  `);

  return result.rows.map((row) => ({
    platformAccountId: normalizeNumber(row.platformAccountId as NumericValue, "platformAccountId"),
    platform: asPlatform(row.platform, "platform"),
    priority: normalizeNumber(row.priority as NumericValue, "priority"),
    requestedAt: normalizeTimestamp(row.requestedAt as TimestampValue, "requestedAt"),
    proxyUrl: typeof row.proxyUrl === "string" ? row.proxyUrl : null,
  })) satisfies SyncTaskWakeupRow[];
}

export async function markSyncTaskWakeupEnqueued(
  db: Database,
  platformAccountId: number,
  now = new Date(),
) {
  await db.execute(sql`
    update sync_tasks
    set last_enqueued_at = ${now},
        updated_at = ${now}
    where platform_account_id = ${platformAccountId}
      and desired_generation > applied_generation
      and (
        status = 'queued'
        or (status = 'retry_wait' and retry_at is not null and retry_at <= ${now})
      )
  `);

  await mirrorLegacySyncStreamState(db, { platformAccountId });
}

export async function acquireNextSyncTaskLeaseForPage(
  db: Database,
  input: {
    platformAccountId: number;
    workerId: string;
    leaseToken: string;
    leaseTtlMs: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = await db.execute<Record<string, unknown>>(sql`
    with candidate as (
      select st.platform_account_id as "platformAccountId",
             st.task as "task",
             st.desired_generation as "desiredGeneration"
      from sync_tasks st
      left join ${syncOperations} so
        on so.platform_account_id = st.platform_account_id
       and so.task = st.task
       and so.generation = st.desired_generation
      where st.platform_account_id = ${input.platformAccountId}
        and st.desired_generation > st.applied_generation
        and (
          st.status = 'queued'
          or (st.status = 'retry_wait' and st.retry_at is not null and st.retry_at <= ${now})
        )
      order by ${taskPriorityBySourceSql("st.task", "so.source")} desc,
               st.last_requested_at asc nulls last,
               ${taskOrderSql("st.task")} asc
      limit 1
    ),
    acquired as (
      update sync_tasks st
      set status = 'running',
          running_generation = candidate."desiredGeneration",
          lease_owner = ${input.workerId},
          lease_token = ${input.leaseToken},
          lease_heartbeat_at = ${now},
          lease_expires_at = ${new Date(now.getTime() + input.leaseTtlMs)},
          last_started_at = ${now},
          updated_at = ${now}
      from candidate
      where st.platform_account_id = candidate."platformAccountId"
        and st.task = candidate."task"
        and st.desired_generation = candidate."desiredGeneration"
        and (
          st.status = 'queued'
          or (st.status = 'retry_wait' and st.retry_at is not null and st.retry_at <= ${now})
        )
      returning st.platform_account_id as "platformAccountId",
                st.task as "task",
                st.status as "status",
                st.desired_generation as "desiredGeneration",
                st.running_generation as "runningGeneration",
                st.applied_generation as "appliedGeneration",
                st.schedule_interval_seconds as "scheduleIntervalSeconds",
                st.slot_offset_seconds as "slotOffsetSeconds",
                st.last_scheduled_slot as "lastScheduledSlot",
                st.last_requested_at as "lastRequestedAt",
                st.last_enqueued_at as "lastEnqueuedAt",
                st.last_started_at as "lastStartedAt",
                st.last_progress_at as "lastProgressAt",
                st.last_finished_at as "lastFinishedAt",
                st.last_success_at as "lastSuccessAt",
                st.last_failure_at as "lastFailureAt",
                st.retry_class as "retryClass",
                st.retry_at as "retryAt",
                st.blocker_type as "blockerType",
                st.blocker_code as "blockerCode",
                st.blocker_reason as "blockerReason",
                st.blocked_since as "blockedSince",
                st.current_phase as "currentPhase",
                st.current_work_class as "currentWorkClass",
                st.progress_payload as "progressPayload",
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
           so.id as "operationId",
           so.source as "operationSource",
           so.request_payload as "requestPayload",
           pa.platform as "platform",
           pap.url as "proxyUrl"
    from acquired
    inner join ${platformAccounts} pa on pa.id = acquired."platformAccountId"
    left join ${platformAccountProxies} pap on pap.platform_account_id = acquired."platformAccountId"
    left join ${syncOperations} so
      on so.platform_account_id = acquired."platformAccountId"
     and so.task = acquired."task"
     and so.generation = acquired."desiredGeneration"
    limit 1
  `);

  const lease = result.rows[0] ? normalizeSyncTaskLeaseRow(result.rows[0]) : null;
  if (lease) {
    await mirrorLegacySyncStreamState(db, {
      platformAccountId: lease.platformAccountId,
      tasks: [lease.task],
    });
  }

  return lease;
}

export async function heartbeatSyncTaskLease(
  db: Database,
  input: {
    platformAccountId: number;
    task: SyncV2Task;
    leaseToken: string;
    leaseTtlMs: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = await db.execute(sql`
    update sync_tasks
    set lease_heartbeat_at = ${now},
        lease_expires_at = ${new Date(now.getTime() + input.leaseTtlMs)},
        updated_at = ${now}
    where platform_account_id = ${input.platformAccountId}
      and task = ${input.task}
      and lease_token = ${input.leaseToken}
      and status = 'running'
  `);

  const cleared = (result.rowCount ?? 0) > 0;
  if (cleared) {
    await mirrorLegacySyncStreamState(db, {
      platformAccountId: input.platformAccountId,
      tasks: [input.task],
    });
  }

  return cleared;
}

export async function clearSyncTaskLease(
  db: Database,
  input: {
    platformAccountId: number;
    task: SyncV2Task;
    leaseToken: string;
    nextStatus: SyncTaskRuntimeState;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = await db.execute(sql`
    update sync_tasks
    set status = ${input.nextStatus}::sync_task_status,
        running_generation = null,
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where platform_account_id = ${input.platformAccountId}
      and task = ${input.task}
      and lease_token = ${input.leaseToken}
  `);

  const completed = (result.rowCount ?? 0) > 0;
  if (completed) {
    await mirrorLegacySyncStreamState(db, {
      platformAccountId: input.platformAccountId,
      tasks: [input.task],
    });
  }

  return completed;
}

export async function completeSyncTaskGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    task: SyncV2Task;
    generation: number;
    leaseToken: string;
    progressAt?: Date | null;
    currentPhase?: string | null;
    currentWorkClass?: SyncWorkClass | null;
    progressPayload?: Record<string, unknown>;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const nextStatus: SyncTaskRuntimeState = "idle";
  const result = await db.execute(sql`
    update sync_tasks
    set status = case
                   when desired_generation > ${input.generation} then 'queued'::sync_task_status
                   else ${nextStatus}::sync_task_status
                 end,
        applied_generation = greatest(applied_generation, ${input.generation}),
        running_generation = null,
        last_progress_at = coalesce(${input.progressAt ?? null}, last_progress_at, ${now}),
        last_finished_at = ${now},
        last_success_at = ${now},
        retry_class = null,
        retry_at = null,
        blocker_type = null,
        blocker_code = null,
        blocker_reason = null,
        blocked_since = null,
        current_phase = ${input.currentPhase ?? null},
        current_work_class = ${input.currentWorkClass ?? null},
        progress_payload = ${input.progressPayload ?? {}},
        consecutive_failures = 0,
        last_error_code = null,
        last_error_summary = null,
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where platform_account_id = ${input.platformAccountId}
      and task = ${input.task}
      and lease_token = ${input.leaseToken}
      and running_generation = ${input.generation}
  `);

  const yielded = (result.rowCount ?? 0) > 0;
  if (yielded) {
    await mirrorLegacySyncStreamState(db, {
      platformAccountId: input.platformAccountId,
      tasks: [input.task],
    });
  }

  return yielded;
}

export async function yieldSyncTaskGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    task: SyncV2Task;
    generation: number;
    leaseToken: string;
    progressAt?: Date | null;
    currentPhase?: string | null;
    currentWorkClass?: SyncWorkClass | null;
    progressPayload?: Record<string, unknown>;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = await db.execute(sql`
    update sync_tasks
    set status = 'queued',
        running_generation = null,
        last_progress_at = coalesce(${input.progressAt ?? null}, last_progress_at),
        last_finished_at = ${now},
        current_phase = ${input.currentPhase ?? null},
        current_work_class = ${input.currentWorkClass ?? null},
        progress_payload = ${input.progressPayload ?? {}},
        consecutive_failures = 0,
        last_error_code = null,
        last_error_summary = null,
        retry_class = null,
        retry_at = null,
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where platform_account_id = ${input.platformAccountId}
      and task = ${input.task}
      and lease_token = ${input.leaseToken}
      and running_generation = ${input.generation}
  `);

  const failed = (result.rowCount ?? 0) > 0;
  if (failed) {
    await mirrorLegacySyncStreamState(db, {
      platformAccountId: input.platformAccountId,
      tasks: [input.task],
    });
  }

  return failed;
}

function resolveRetryDelayMs(consecutiveFailures: number) {
  const seconds = 60 * (2 ** Math.max(0, consecutiveFailures - 1));
  return Math.min(seconds, 30 * 60) * 1000;
}

export async function failSyncTaskGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    task: SyncV2Task;
    generation: number;
    leaseToken: string;
    retryClass: string;
    errorCode: string | null;
    errorSummary: string;
    progressAt?: Date | null;
    currentPhase?: string | null;
    currentWorkClass?: SyncWorkClass | null;
    progressPayload?: Record<string, unknown>;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const row = await getSyncTaskRow(db, input.platformAccountId, input.task);
  const nextFailures = (row?.consecutiveFailures ?? 0) + 1;
  const retryAt = new Date(now.getTime() + resolveRetryDelayMs(nextFailures));
  const result = await db.execute(sql`
    update sync_tasks
    set status = 'retry_wait',
        running_generation = null,
        last_progress_at = coalesce(${input.progressAt ?? null}, last_progress_at),
        last_finished_at = ${now},
        last_failure_at = ${now},
        retry_class = ${input.retryClass},
        retry_at = ${retryAt},
        blocker_type = null,
        blocker_code = null,
        blocker_reason = null,
        blocked_since = null,
        current_phase = ${input.currentPhase ?? null},
        current_work_class = ${input.currentWorkClass ?? null},
        progress_payload = ${input.progressPayload ?? {}},
        consecutive_failures = ${nextFailures},
        last_error_code = ${input.errorCode},
        last_error_summary = ${input.errorSummary},
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where platform_account_id = ${input.platformAccountId}
      and task = ${input.task}
      and lease_token = ${input.leaseToken}
      and running_generation = ${input.generation}
  `);

  const blocked = (result.rowCount ?? 0) > 0;
  if (blocked) {
    await mirrorLegacySyncStreamState(db, {
      platformAccountId: input.platformAccountId,
      tasks: [input.task],
    });
  }

  return blocked;
}

export async function blockSyncTaskGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    task: SyncV2Task;
    generation: number;
    leaseToken: string;
    blockerType: string;
    blockerCode: string;
    blockerReason: string;
    errorCode: string | null;
    errorSummary: string;
    progressAt?: Date | null;
    currentPhase?: string | null;
    currentWorkClass?: SyncWorkClass | null;
    progressPayload?: Record<string, unknown>;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const row = await getSyncTaskRow(db, input.platformAccountId, input.task);
  const nextFailures = (row?.consecutiveFailures ?? 0) + 1;
  const result = await db.execute(sql`
    update sync_tasks
    set status = 'blocked',
        running_generation = null,
        last_progress_at = coalesce(${input.progressAt ?? null}, last_progress_at),
        last_finished_at = ${now},
        last_failure_at = ${now},
        retry_class = null,
        retry_at = null,
        blocker_type = ${input.blockerType},
        blocker_code = ${input.blockerCode},
        blocker_reason = ${input.blockerReason},
        blocked_since = coalesce(blocked_since, ${now}),
        current_phase = ${input.currentPhase ?? null},
        current_work_class = ${input.currentWorkClass ?? null},
        progress_payload = ${input.progressPayload ?? {}},
        consecutive_failures = ${nextFailures},
        last_error_code = ${input.errorCode},
        last_error_summary = ${input.errorSummary},
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where platform_account_id = ${input.platformAccountId}
      and task = ${input.task}
      and lease_token = ${input.leaseToken}
      and running_generation = ${input.generation}
  `);

  return (result.rowCount ?? 0) > 0;
}

export async function pauseSyncTasks(
  db: Database,
  input: {
    platformAccountId: number;
    tasks: SyncV2Task[];
    now?: Date;
  },
) {
  if (input.tasks.length === 0) {
    return;
  }

  const now = input.now ?? new Date();
  await db.execute(sql`
    update sync_tasks
    set status = 'paused',
        running_generation = null,
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        updated_at = ${now}
    where platform_account_id = ${input.platformAccountId}
      and task = any(${taskArraySql(input.tasks)})
  `);

  await mirrorLegacySyncStreamState(db, {
    platformAccountId: input.platformAccountId,
    tasks: input.tasks,
  });
}

export async function resumeSyncTasks(
  db: Database,
  input: {
    platformAccountId: number;
    tasks: SyncV2Task[];
    now?: Date;
  },
) {
  if (input.tasks.length === 0) {
    return;
  }

  const now = input.now ?? new Date();
  await db.execute(sql`
    update sync_tasks
    set status = case
                   when blocker_type is not null then 'blocked'::sync_task_status
                   when desired_generation > applied_generation then 'queued'::sync_task_status
                   else 'idle'::sync_task_status
                 end,
        updated_at = ${now}
    where platform_account_id = ${input.platformAccountId}
      and task = any(${taskArraySql(input.tasks)})
      and status = 'paused'
  `);

  await mirrorLegacySyncStreamState(db, {
    platformAccountId: input.platformAccountId,
    tasks: input.tasks,
  });
}

export async function resetSyncTasks(
  db: Database,
  input: {
    platformAccountId: number;
    tasks: SyncV2Task[];
    now?: Date;
  },
) {
  if (input.tasks.length === 0) {
    return;
  }

  const now = input.now ?? new Date();
  await db.execute(sql`
    delete from ${syncCursors}
    where platform_account_id = ${input.platformAccountId}
      and task = any(${taskArraySql(input.tasks)})
  `);

  await mirrorLegacySyncStreamState(db, {
    platformAccountId: input.platformAccountId,
    tasks: input.tasks,
  });

  await db.execute(sql`
    update sync_tasks
    set running_generation = null,
        applied_generation = applied_generation,
        retry_class = null,
        retry_at = null,
        blocker_type = case when blocker_type = 'auth' then blocker_type else null end,
        blocker_code = case when blocker_type = 'auth' then blocker_code else null end,
        blocker_reason = case when blocker_type = 'auth' then blocker_reason else null end,
        blocked_since = case when blocker_type = 'auth' then blocked_since else null end,
        current_phase = null,
        progress_payload = '{}'::jsonb,
        lease_owner = null,
        lease_token = null,
        lease_heartbeat_at = null,
        lease_expires_at = null,
        consecutive_failures = 0,
        last_error_code = null,
        last_error_summary = null,
        status = case
                   when status = 'paused' then 'paused'::sync_task_status
                   when blocker_type = 'auth' then 'blocked'::sync_task_status
                   else 'idle'::sync_task_status
                 end,
        updated_at = ${now}
    where platform_account_id = ${input.platformAccountId}
      and task = any(${taskArraySql(input.tasks)})
  `);
}

export async function requestSyncTaskGenerations(
  db: Database,
  input: {
    platformAccountId: number;
    tasks: SyncV2Task[];
    source: SyncOperationSource;
    requestPayloadByTask?: Partial<Record<SyncV2Task, Record<string, unknown> | null>>;
    requestedByActor?: string | null;
    requestedByUserId?: number | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const results: Array<{ task: SyncV2Task; desiredGeneration: number }> = [];

  await ensureSyncTaskRows(db, {
    platformAccountId: input.platformAccountId,
    onboarding: input.source === "onboarding",
    now,
  });

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    for (const task of input.tasks) {
      const current = await getSyncTaskRow(database, input.platformAccountId, task);
      if (!current) {
        throw new Error(`Sync task "${task}" does not exist for page ${input.platformAccountId}`);
      }

      const nextGeneration = current.desiredGeneration + 1;
      await database.insert(syncOperations).values({
        platformAccountId: input.platformAccountId,
        task,
        generation: nextGeneration,
        source: input.source,
        requestedByActor: input.requestedByActor ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
        requestPayload: input.requestPayloadByTask?.[task] ?? {},
        requestedAt: now,
      }).onConflictDoNothing();

      const nextStatus: SyncTaskRuntimeState = current.status === "paused"
        ? "paused"
        : current.status === "blocked"
          ? "blocked"
          : "queued";

      await database.execute(sql`
        update sync_tasks
        set desired_generation = ${nextGeneration},
            last_requested_at = ${now},
            status = ${nextStatus}::sync_task_status,
            retry_class = case when ${nextStatus === "queued"} then null else retry_class end,
            retry_at = case when ${nextStatus === "queued"} then null else retry_at end,
            updated_at = ${now}
        where platform_account_id = ${input.platformAccountId}
          and task = ${task}
      `);

      results.push({
        task,
        desiredGeneration: nextGeneration,
      });
    }
  });

  await mirrorLegacySyncStreamState(db, {
    platformAccountId: input.platformAccountId,
    tasks: input.tasks,
  });

  return results;
}
