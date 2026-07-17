import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import type {
  OfapiBudgetScope,
  OfapiCaptureCreatedBy,
  OfapiCaptureJobGoal,
  OfapiCaptureJobKind,
  OfapiCaptureJobState,
  OfapiHttpOutcome,
  OfapiParserOutcome,
  OfapiRequestAttemptState,
} from "../schema.ts";
import { appendProjectionOnlyDomainEventsInTransaction } from "./domain-events.ts";
import {
  matchesOfapiMessageCoverageProofReference,
  type OfapiMessageCoverageProofReference,
} from "./ofapi-message-coverage.ts";
import { insertObservation } from "./observations.ts";

export const OFAPI_CAPTURE_SOURCE_CONTRACT_VERSION = "ofapi-capture-v2";
export const OFAPI_CAPTURE_PARSER_VERSION = "ofapi-capture-parser-v2";
export const OFAPI_CAPTURE_PROOF_POLICY_VERSION = "ofapi-proof-v1";
export const OFAPI_CAPTURE_POLICY_VERSION = "ofapi-admission-v1";
export const OFAPI_STORAGE_HEALTH_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const OFAPI_STORAGE_HEALTH_RETRY_MS = 5 * 60 * 1000;
const OFAPI_BUDGET_RECHECK_MS = 15 * 60 * 1000;
const OFAPI_PAUSE_RECHECK_MS = 24 * 60 * 60 * 1000;
const OFAPI_DEADLINE_RECHECK_MS = 60 * 1000;

export class OfapiCaptureInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfapiCaptureInvariantError";
  }
}

function asNumber(value: unknown, field: string) {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new OfapiCaptureInvariantError(`Invalid ${field}: ${String(value)}`);
  }
  return number;
}

function asNullableNumber(value: unknown, field: string) {
  return value === null || value === undefined ? null : asNumber(value, field);
}

function asDate(value: unknown, field: string) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new OfapiCaptureInvariantError(`Invalid ${field}: ${String(value)}`);
  }
  return date;
}

function asNullableDate(value: unknown, field: string) {
  return value === null || value === undefined ? null : asDate(value, field);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OfapiCaptureInvariantError(`Invalid ${field}: expected object`);
  }
  return value as Record<string, unknown>;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalJson(record[key])]),
    );
  }
  return value;
}

export function hashOfapiCaptureValue(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)))
    .digest("hex");
}

function utcDay(now: Date) {
  return now.toISOString().slice(0, 10);
}

function utcHour(now: Date) {
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  return hour;
}

function nextUtcDay(now: Date) {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next;
}

function normalizeCredits(value: number) {
  if (!Number.isFinite(value)) {
    throw new OfapiCaptureInvariantError("Credit value must be finite");
  }
  return Math.max(0, Math.round(value));
}

export interface OfapiCaptureJobRecord {
  id: string;
  pageId: number;
  ofapiAccountId: string;
  kind: OfapiCaptureJobKind;
  goal: OfapiCaptureJobGoal | null;
  state: OfapiCaptureJobState;
  activeSlotKey: string;
  target: Record<string, unknown>;
  targetHash: string;
  targetGeneration: number;
  manifest: Record<string, unknown> | null;
  cursor: Record<string, unknown> | null;
  cursorHash: string | null;
  rowVersion: number;
  nextAttemptAt: Date;
  priority: number;
  budgetScope: OfapiBudgetScope;
  originPrincipalId: number | null;
  createdBy: OfapiCaptureCreatedBy;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseUntil: Date | null;
  pendingObservationId: number | null;
  pendingObservationReceivedAt: Date | null;
  terminalObservationId: number | null;
  terminalObservationReceivedAt: Date | null;
  result: Record<string, unknown> | null;
  reasonCode: string | null;
  reasonMessage: string | null;
  maxCalls: number | null;
  maxCredits: number | null;
  maxPages: number | null;
  maxItems: number | null;
  attemptCount: number;
  dispatchCount: number;
  spentCredits: number;
  acceptedItems: number;
  acceptedPages: number;
  zeroProgressCount: number;
  sourceContractVersion: string;
  parserVersion: string;
  proofPolicyVersion: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

function mapCaptureJob(row: Record<string, unknown>): OfapiCaptureJobRecord {
  return {
    id: String(row.id),
    pageId: asNumber(row.page_id, "page_id"),
    ofapiAccountId: String(row.ofapi_account_id),
    kind: String(row.kind) as OfapiCaptureJobKind,
    goal: row.goal === null ? null : String(row.goal) as OfapiCaptureJobGoal,
    state: String(row.state) as OfapiCaptureJobState,
    activeSlotKey: String(row.active_slot_key),
    target: asRecord(row.target, "target"),
    targetHash: String(row.target_hash),
    targetGeneration: asNumber(row.target_generation, "target_generation"),
    manifest: row.manifest === null ? null : asRecord(row.manifest, "manifest"),
    cursor: row.cursor === null ? null : asRecord(row.cursor, "cursor"),
    cursorHash: row.cursor_hash === null ? null : String(row.cursor_hash),
    rowVersion: asNumber(row.row_version, "row_version"),
    nextAttemptAt: asDate(row.next_attempt_at, "next_attempt_at"),
    priority: asNumber(row.priority, "priority"),
    budgetScope: String(row.budget_scope) as OfapiBudgetScope,
    originPrincipalId: asNullableNumber(row.origin_principal_id, "origin_principal_id"),
    createdBy: String(row.created_by) as OfapiCaptureCreatedBy,
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseToken: row.lease_token === null ? null : String(row.lease_token),
    leaseUntil: asNullableDate(row.lease_until, "lease_until"),
    pendingObservationId: asNullableNumber(row.pending_observation_id, "pending_observation_id"),
    pendingObservationReceivedAt: asNullableDate(
      row.pending_observation_received_at,
      "pending_observation_received_at",
    ),
    terminalObservationId: asNullableNumber(row.terminal_observation_id, "terminal_observation_id"),
    terminalObservationReceivedAt: asNullableDate(
      row.terminal_observation_received_at,
      "terminal_observation_received_at",
    ),
    result: row.result === null ? null : asRecord(row.result, "result"),
    reasonCode: row.reason_code === null ? null : String(row.reason_code),
    reasonMessage: row.reason_message === null ? null : String(row.reason_message),
    maxCalls: asNullableNumber(row.max_calls, "max_calls"),
    maxCredits: asNullableNumber(row.max_credits, "max_credits"),
    maxPages: asNullableNumber(row.max_pages, "max_pages"),
    maxItems: asNullableNumber(row.max_items, "max_items"),
    attemptCount: asNumber(row.attempt_count, "attempt_count"),
    dispatchCount: asNumber(row.dispatch_count, "dispatch_count"),
    spentCredits: asNumber(row.spent_credits, "spent_credits"),
    acceptedItems: asNumber(row.accepted_items, "accepted_items"),
    acceptedPages: asNumber(row.accepted_pages, "accepted_pages"),
    zeroProgressCount: asNumber(row.zero_progress_count, "zero_progress_count"),
    sourceContractVersion: String(row.source_contract_version),
    parserVersion: String(row.parser_version),
    proofPolicyVersion: String(row.proof_policy_version),
    createdAt: asDate(row.created_at, "created_at"),
    updatedAt: asDate(row.updated_at, "updated_at"),
    completedAt: asNullableDate(row.completed_at, "completed_at"),
  };
}

export interface CreateOfapiCaptureJobInput {
  id?: string;
  pageId: number;
  ofapiAccountId: string;
  kind: OfapiCaptureJobKind;
  goal?: OfapiCaptureJobGoal | null;
  activeSlotKey: string;
  target: Record<string, unknown>;
  targetGeneration?: number;
  manifest?: Record<string, unknown> | null;
  budgetScope: OfapiBudgetScope;
  originPrincipalId?: number | null;
  createdBy: OfapiCaptureCreatedBy;
  priority?: number;
  maxCalls?: number | null;
  maxCredits?: number | null;
  maxPages?: number | null;
  maxItems?: number | null;
  sourceContractVersion?: string;
  parserVersion?: string;
  proofPolicyVersion?: string;
  now?: Date;
}

export async function createOrGetOfapiCaptureJob(
  db: Database,
  input: CreateOfapiCaptureJobInput,
): Promise<{ created: boolean; job: OfapiCaptureJobRecord }> {
  const now = input.now ?? new Date();
  const id = input.id ?? randomUUID();
  const expectedPrefix = `page:${input.pageId}:`;
  if (!input.activeSlotKey.startsWith(expectedPrefix)) {
    throw new OfapiCaptureInvariantError(
      `activeSlotKey must start with ${expectedPrefix}`,
    );
  }
  if (input.kind === "chat_paginate" && !input.goal) {
    throw new OfapiCaptureInvariantError("chat_paginate requires a typed goal");
  }
  if (input.kind !== "chat_paginate" && input.goal) {
    throw new OfapiCaptureInvariantError(`${input.kind} cannot carry a chat goal`);
  }
  if (input.budgetScope === "interactive" && !input.originPrincipalId) {
    throw new OfapiCaptureInvariantError("interactive jobs require originPrincipalId");
  }

  const targetHash = hashOfapiCaptureValue(input.target);
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const inserted = await database.execute<Record<string, unknown>>(sql`
      insert into ofapi_capture_jobs (
        id, page_id, ofapi_account_id, kind, goal, state,
        active_slot_key, target, target_hash, target_generation, manifest,
        next_attempt_at, priority, budget_scope, origin_principal_id, created_by,
        max_calls, max_credits, max_pages, max_items,
        source_contract_version, parser_version, proof_policy_version,
        created_at, updated_at
      ) values (
        ${id}::uuid,
        ${input.pageId},
        ${input.ofapiAccountId},
        ${input.kind},
        ${input.goal ?? null},
        'ready',
        ${input.activeSlotKey},
        ${JSON.stringify(input.target)}::jsonb,
        ${targetHash},
        ${Math.max(0, Math.trunc(input.targetGeneration ?? 0))},
        ${input.manifest ? JSON.stringify(input.manifest) : null}::jsonb,
        ${now},
        ${Math.trunc(input.priority ?? 0)},
        ${input.budgetScope},
        ${input.originPrincipalId ?? null},
        ${input.createdBy},
        ${input.maxCalls ?? null},
        ${input.maxCredits ?? null},
        ${input.maxPages ?? null},
        ${input.maxItems ?? null},
        ${input.sourceContractVersion ?? OFAPI_CAPTURE_SOURCE_CONTRACT_VERSION},
        ${input.parserVersion ?? OFAPI_CAPTURE_PARSER_VERSION},
        ${input.proofPolicyVersion ?? OFAPI_CAPTURE_PROOF_POLICY_VERSION},
        ${now},
        ${now}
      )
      on conflict do nothing
      returning *
    `);
    if (inserted.rows[0]) {
      return { created: true, job: mapCaptureJob(inserted.rows[0]) };
    }

    const existing = await database.execute<Record<string, unknown>>(sql`
      select *
      from ofapi_capture_jobs
      where active_slot_key = ${input.activeSlotKey}
        and state in ('ready', 'leased', 'awaiting_parse', 'retry_wait', 'blocked')
      for update
    `);
    const row = existing.rows[0];
    if (row) {
      return { created: false, job: mapCaptureJob(row) };
    }

    // The exact target may have completed between the insert conflict and the
    // active-slot lookup. Treat a successful historical instance as the same
    // durable intent instead of creating another paid job.
    const completed = await findCompletedOfapiCaptureJobByTarget(database, {
      activeSlotKey: input.activeSlotKey,
      targetHash,
      kind: input.kind,
      goal: input.goal ?? null,
    });
    if (completed) {
      return { created: false, job: completed };
    }
    throw new OfapiCaptureInvariantError(
      `Slot ${input.activeSlotKey} conflicted but no matching job exists`,
    );
  });
}

export async function findActiveOfapiCaptureJobBySlot(
  db: Database,
  activeSlotKey: string,
) {
  const result = await db.execute<Record<string, unknown>>(sql`
    select *
    from ofapi_capture_jobs
    where active_slot_key = ${activeSlotKey}
      and state in ('ready', 'leased', 'awaiting_parse', 'retry_wait', 'blocked')
    limit 1
  `);
  return result.rows[0] ? mapCaptureJob(result.rows[0]) : null;
}

export async function findCompletedOfapiCaptureJobByTarget(
  db: Database,
  input: {
    activeSlotKey: string;
    targetHash: string;
    kind: OfapiCaptureJobKind;
    goal: OfapiCaptureJobGoal | null;
  },
) {
  const result = await db.execute<Record<string, unknown>>(sql`
    select *
    from ofapi_capture_jobs
    where active_slot_key = ${input.activeSlotKey}
      and target_hash = ${input.targetHash}
      and kind = ${input.kind}
      and goal is not distinct from ${input.goal}
      and state = 'complete'
    order by completed_at desc nulls last, created_at desc
    limit 1
  `);
  return result.rows[0] ? mapCaptureJob(result.rows[0]) : null;
}

export interface CreateOfapiInteractiveRequestInput {
  id?: string;
  pageId: number;
  ofapiAccountId: string;
  principalUserId: number;
  operation: string;
  surface: string;
  target: Record<string, unknown>;
  policyVersion?: string;
  now?: Date;
}

export async function createOfapiInteractiveRequest(
  db: Database,
  input: CreateOfapiInteractiveRequestInput,
) {
  const now = input.now ?? new Date();
  const id = input.id ?? randomUUID();
  const requestFingerprint = hashOfapiCaptureValue(input.target);
  await db.execute(sql`
    insert into ofapi_interactive_requests (
      id, page_id, ofapi_account_id, principal_user_id,
      operation, surface, target, request_fingerprint, state,
      policy_version, created_at, updated_at
    ) values (
      ${id}::uuid,
      ${input.pageId},
      ${input.ofapiAccountId},
      ${input.principalUserId},
      ${input.operation},
      ${input.surface},
      ${JSON.stringify(input.target)}::jsonb,
      ${requestFingerprint},
      'created',
      ${input.policyVersion ?? OFAPI_CAPTURE_POLICY_VERSION},
      ${now},
      ${now}
    )
  `);
  return { id, requestFingerprint };
}

export async function listRunnableOfapiCapturePages(
  db: Database,
  input?: { now?: Date; limit?: number },
) {
  const now = input?.now ?? new Date();
  const limit = Math.max(1, Math.min(10_000, Math.trunc(input?.limit ?? 1_000)));
  const result = await db.execute<{
    page_id: unknown;
    priority: unknown;
    requested_at: unknown;
  }>(sql`
    select page_id,
           max(priority)::int as priority,
           min(case when state = 'awaiting_parse' then updated_at else next_attempt_at end) as requested_at
    from ofapi_capture_jobs
    where (state = 'awaiting_parse' and reason_code is null)
       or (state in ('ready', 'retry_wait') and next_attempt_at <= ${now})
    group by page_id
    order by max(priority) desc,
             min(case when state = 'awaiting_parse' then updated_at else next_attempt_at end),
             page_id
    limit ${limit}
  `);
  return result.rows.map((row) => ({
    pageId: asNumber(row.page_id, "page_id"),
    priority: asNumber(row.priority, "priority"),
    requestedAt: asDate(row.requested_at, "requested_at"),
  }));
}

export async function leaseNextOfapiCaptureJob(
  db: Database,
  input: {
    pageId: number;
    leaseOwner: string;
    leaseToken?: string;
    leaseTtlMs: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + Math.max(1_000, input.leaseTtlMs));
  const leaseToken = input.leaseToken ?? randomUUID();
  const result = await db.execute<Record<string, unknown>>(sql`
    with candidate as (
      select id
      from ofapi_capture_jobs
      where page_id = ${input.pageId}
        and (
          (state = 'awaiting_parse' and reason_code is null)
          or (state in ('ready', 'retry_wait') and next_attempt_at <= ${now})
        )
      order by (state = 'awaiting_parse') desc,
               priority desc,
               case when state = 'awaiting_parse' then updated_at else next_attempt_at end,
               created_at,
               id
      for update skip locked
      limit 1
    )
    update ofapi_capture_jobs job
    set state = case when job.state = 'awaiting_parse' then 'awaiting_parse' else 'leased' end,
        lease_owner = ${input.leaseOwner},
        lease_token = ${leaseToken}::uuid,
        lease_until = ${leaseUntil},
        row_version = row_version + 1,
        updated_at = ${now}
    from candidate
    where job.id = candidate.id
    returning job.*
  `);
  return result.rows[0] ? mapCaptureJob(result.rows[0]) : null;
}

export async function blockOfapiCaptureJobLease(
  db: Database,
  input: {
    jobId: string;
    leaseToken: string;
    reasonCode: string;
    reasonMessage?: string | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = await db.execute<{ id: string }>(sql`
    update ofapi_capture_jobs
    set state = 'blocked',
        reason_code = ${input.reasonCode},
        reason_message = ${input.reasonMessage ?? null},
        lease_owner = null,
        lease_token = null,
        lease_until = null,
        row_version = row_version + 1,
        updated_at = ${now}
    where id = ${input.jobId}::uuid
      and state in ('leased', 'awaiting_parse')
      and lease_token = ${input.leaseToken}::uuid
    returning id::text as id
  `);
  return result.rows.length === 1;
}

export async function loadOfapiCaptureObservation(
  db: Database,
  input: {
    observationId: number;
    observationReceivedAt: Date;
  },
) {
  const result = await db.execute<{
    id: string;
    received_at: Date | string;
    kind: string;
    payload: unknown;
    attempt_id: string | null;
  }>(sql`
    select observation.id::text as id,
           observation.received_at,
           observation.kind,
           observation.payload,
           attempt.id::text as attempt_id
    from observations observation
    left join ofapi_request_attempts attempt
      on attempt.response_observation_id = observation.id
     and attempt.response_observation_received_at = observation.received_at
    where observation.id = ${input.observationId}
      and observation.received_at = ${input.observationReceivedAt}
      and observation.source = 'ofapi_capture'
  `);
  const row = result.rows[0];
  return row
    ? {
      id: Number(row.id),
      receivedAt: new Date(row.received_at),
      kind: row.kind,
      payload: row.payload,
      attemptId: row.attempt_id,
    }
    : null;
}

export type OfapiBudgetDenialReason =
  | "global_cap"
  | "scope_cap"
  | "job_cap"
  | "manifest_cap"
  | "principal_credit_cap"
  | "principal_call_cap"
  | "principal_storm_block"
  | "credit_floor"
  | "balance_stale"
  | "storage_unhealthy"
  | "persistent_pause"
  | "deadline";

export interface ReserveOfapiRequestAttemptInput {
  attemptId?: string;
  ownerKind: "capture_job" | "interactive_request";
  ownerId: string;
  pageId: number;
  ofapiAccountId: string;
  originPrincipalId?: number | null;
  budgetScope: OfapiBudgetScope;
  operation: string;
  endpointClass: string;
  egressKey: string;
  method: "GET" | "POST" | "DELETE" | "PATCH";
  requestSemantics: "safe_read" | "stateful";
  requestShape: Record<string, unknown>;
  surface?: string | null;
  servingMode?: "vendor_only" | "shadow" | "db_fallback" | "db_only" | null;
  fallbackReason?:
    | "surface_not_cutover"
    | "no_certificate"
    | "stale_head"
    | "gap"
    | "projection_lag"
    | "shadow_probe"
    | null;
  reservedCredits: number;
  globalDailyCap: number;
  scopeDailyCap: number;
  creditFloor: number;
  balanceMaxAgeMs: number;
  allowFloorProbe?: boolean;
  floorProbeCooldownMs?: number;
  principalCallCap?: number;
  principalCreditCap?: number;
  denialBlockThreshold?: number;
  denialBlockMs?: number;
  requireFreshStorageHealth?: boolean;
  storageHealthMaxAgeMs?: number;
  jobLeaseToken?: string | null;
  deadlineAt: Date;
  policyVersion?: string;
  sourceContractVersion?: string;
  parserVersion?: string;
  now?: Date;
}

export type ReserveOfapiRequestAttemptResult =
  | {
    admitted: true;
    attemptId: string;
    fenceToken: string;
    ownerAttemptNo: number;
    isFloorProbe: boolean;
  }
  | {
    admitted: false;
    reason: OfapiBudgetDenialReason;
    retryAt: Date | null;
  };

interface CreditStateRow extends Record<string, unknown> {
  spend_day: string | Date | null;
  spent_credits: unknown;
  audience_spend_day: string | Date | null;
  audience_spent_credits: unknown;
  backfill_spend_day: string | Date | null;
  backfill_spent_credits: unknown;
  governed_scope_day: string | Date | null;
  live_spent_credits: unknown;
  interactive_spent_credits: unknown;
  bulk_spent_credits: unknown;
  governed_unsettled_credits: unknown;
  floor_probe_not_before: string | Date | null;
  last_balance: unknown;
  last_balance_at: string | Date | null;
}

function dateOnly(value: string | Date | null) {
  if (value === null) return null;
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function scopeSpentToday(row: CreditStateRow, scope: OfapiBudgetScope, day: string) {
  const governedDayMatches = dateOnly(row.governed_scope_day) === day;
  switch (scope) {
    case "live":
      return (governedDayMatches
        ? asNumber(row.live_spent_credits, "live_spent_credits")
        : 0) + (
        dateOnly(row.audience_spend_day) === day
          ? asNumber(row.audience_spent_credits, "audience_spent_credits")
          : 0
      );
    case "interactive":
      return governedDayMatches
        ? asNumber(row.interactive_spent_credits, "interactive_spent_credits")
        : 0;
    case "bulk":
      return (governedDayMatches
        ? asNumber(row.bulk_spent_credits, "bulk_spent_credits")
        : 0) + (
        dateOnly(row.backfill_spend_day) === day
          ? asNumber(row.backfill_spent_credits, "backfill_spent_credits")
          : 0
      );
  }
}

function resolveDenialRetryAt(
  reason: OfapiBudgetDenialReason,
  now: Date,
  input: {
    principalBlockedUntil?: Date | null;
    floorProbeNotBefore?: Date | null;
  },
) {
  switch (reason) {
    case "global_cap":
    case "scope_cap":
      return nextUtcDay(now);
    case "job_cap":
    case "manifest_cap":
      return null;
    case "principal_call_cap":
    case "principal_credit_cap": {
      const nextHour = utcHour(now);
      nextHour.setUTCHours(nextHour.getUTCHours() + 1);
      return nextHour;
    }
    case "principal_storm_block":
      return input.principalBlockedUntil ?? new Date(now.getTime() + OFAPI_BUDGET_RECHECK_MS);
    case "balance_stale":
      return input.floorProbeNotBefore ?? new Date(now.getTime() + OFAPI_BUDGET_RECHECK_MS);
    case "storage_unhealthy":
      return new Date(now.getTime() + OFAPI_STORAGE_HEALTH_RETRY_MS);
    case "credit_floor":
      return new Date(now.getTime() + OFAPI_BUDGET_RECHECK_MS);
    case "persistent_pause":
      // Resume wakes these rows immediately. The long fallback keeps an
      // orphaned pause from becoming a permanent active-slot pin without
      // creating a hot admission loop while an incident pause remains set.
      return new Date(now.getTime() + OFAPI_PAUSE_RECHECK_MS);
    case "deadline":
      return new Date(now.getTime() + OFAPI_DEADLINE_RECHECK_MS);
  }
}

async function recordBudgetDenial(
  db: Database,
  input: {
    day: string;
    scope: OfapiBudgetScope;
    pageId: number;
    principalUserId: number | null;
    reason: OfapiBudgetDenialReason;
    thresholdCrossing: boolean;
    now: Date;
  },
) {
  const principalKey = input.principalUserId === null
    ? "system"
    : `user:${input.principalUserId}`;
  await db.execute(sql`
    insert into ofapi_budget_denial_daily (
      day, scope, page_id, principal_key, principal_user_id, reason,
      denied_count, threshold_crossings, first_denied_at, last_denied_at
    ) values (
      ${input.day}::date,
      ${input.scope},
      ${input.pageId},
      ${principalKey},
      ${input.principalUserId},
      ${input.reason},
      1,
      ${input.thresholdCrossing ? 1 : 0},
      ${input.now},
      ${input.now}
    )
    on conflict (day, scope, page_id, principal_key, reason) do update set
      denied_count = ofapi_budget_denial_daily.denied_count + 1,
      threshold_crossings = ofapi_budget_denial_daily.threshold_crossings + excluded.threshold_crossings,
      last_denied_at = excluded.last_denied_at
  `);
}

async function parkDeniedOwner(
  db: Database,
  input: ReserveOfapiRequestAttemptInput,
  reason: OfapiBudgetDenialReason,
  retryAt: Date | null,
  now: Date,
) {
  if (input.ownerKind === "capture_job") {
    await db.execute(sql`
      update ofapi_capture_jobs
      set state = ${retryAt ? "retry_wait" : "blocked"},
          next_attempt_at = coalesce(${retryAt}, next_attempt_at),
          reason_code = ${reason},
          reason_message = ${`Admission denied: ${reason}`},
          lease_owner = null,
          lease_token = null,
          lease_until = null,
          row_version = row_version + 1,
          updated_at = ${now}
      where id = ${input.ownerId}::uuid
    `);
  } else {
    await db.execute(sql`
      update ofapi_interactive_requests
      set state = 'failed',
          error_code = ${`admission_${reason}`},
          completed_at = ${now},
          row_version = row_version + 1,
          updated_at = ${now}
      where id = ${input.ownerId}::uuid
        and state = 'created'
    `);
  }
}

export async function reserveOfapiRequestAttempt(
  db: Database,
  input: ReserveOfapiRequestAttemptInput,
): Promise<ReserveOfapiRequestAttemptResult> {
  const now = input.now ?? new Date();
  const day = utcDay(now);
  const attemptId = input.attemptId ?? randomUUID();
  const fenceToken = randomUUID();
  const estimate = normalizeCredits(input.reservedCredits);
  const globalCap = normalizeCredits(input.globalDailyCap);
  const scopeCap = normalizeCredits(input.scopeDailyCap);
  const creditFloor = normalizeCredits(input.creditFloor);
  const principalCallCap = Math.max(0, Math.trunc(input.principalCallCap ?? Number.MAX_SAFE_INTEGER));
  const principalCreditCap = normalizeCredits(input.principalCreditCap ?? Number.MAX_SAFE_INTEGER);
  const denialThreshold = Math.max(1, Math.trunc(input.denialBlockThreshold ?? 5));
  const denialBlockMs = Math.max(1_000, input.denialBlockMs ?? 15 * 60 * 1000);
  const principalId = input.originPrincipalId ?? null;

  if (input.deadlineAt.getTime() <= now.getTime()) {
    return db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      const retryAt = resolveDenialRetryAt("deadline", now, {});
      await recordBudgetDenial(database, {
        day,
        scope: input.budgetScope,
        pageId: input.pageId,
        principalUserId: principalId,
        reason: "deadline",
        thresholdCrossing: false,
        now,
      });
      await parkDeniedOwner(database, input, "deadline", retryAt, now);
      return { admitted: false, reason: "deadline", retryAt };
    });
  }

  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;

    const paused = await database.execute<{ control_key: string }>(sql`
      select control_key
      from ofapi_capture_controls
      where paused = true
        and control_key in (
          'global',
          ${`page:${input.pageId}`},
          ${`scope:${input.budgetScope}`},
          ${`operation:${input.operation}`}
        )
      order by control_key
      for share
      limit 1
    `);

    await database.execute(sql`
      insert into ofapi_credit_state (id, updated_at)
      values (1, ${now})
      on conflict (id) do nothing
    `);
    const creditResult = await database.execute<CreditStateRow>(sql`
      select * from ofapi_credit_state where id = 1 for update
    `);
    const credit = creditResult.rows[0];
    if (!credit) {
      throw new OfapiCaptureInvariantError("OFAPI credit singleton is missing after insert");
    }

    let principal: {
      window_started_at: string | Date;
      used_calls: unknown;
      used_credits: unknown;
      consecutive_budget_denials: unknown;
      blocked_until: string | Date | null;
    } | null = null;
    const principalWindow = principalId === null ? null : utcHour(now);
    if (principalId !== null && principalWindow) {
      await database.execute(sql`
        insert into ofapi_principal_budget_state (
          principal_user_id, window_started_at, updated_at
        ) values (${principalId}, ${principalWindow}, ${now})
        on conflict (principal_user_id) do nothing
      `);
      const principalResult = await database.execute<typeof principal extends infer _ ? {
        window_started_at: string | Date;
        used_calls: unknown;
        used_credits: unknown;
        consecutive_budget_denials: unknown;
        blocked_until: string | Date | null;
      } : never>(sql`
        select window_started_at, used_calls, used_credits,
               consecutive_budget_denials, blocked_until
        from ofapi_principal_budget_state
        where principal_user_id = ${principalId}
        for update
      `);
      principal = principalResult.rows[0] ?? null;
      if (!principal) {
        throw new OfapiCaptureInvariantError("Principal budget row disappeared");
      }
      const storedWindow = asDate(principal.window_started_at, "window_started_at");
      if (storedWindow.getTime() !== principalWindow.getTime()) {
        await database.execute(sql`
          update ofapi_principal_budget_state
          set window_started_at = ${principalWindow},
              used_calls = 0,
              used_credits = 0,
              consecutive_budget_denials = 0,
              blocked_until = null,
              updated_at = ${now}
          where principal_user_id = ${principalId}
        `);
        principal = {
          window_started_at: principalWindow,
          used_calls: 0,
          used_credits: 0,
          consecutive_budget_denials: 0,
          blocked_until: null,
        };
      }
    }

    let job: OfapiCaptureJobRecord | null = null;
    if (input.ownerKind === "capture_job") {
      const jobResult = await database.execute<Record<string, unknown>>(sql`
        select * from ofapi_capture_jobs where id = ${input.ownerId}::uuid for update
      `);
      if (!jobResult.rows[0]) {
        throw new OfapiCaptureInvariantError(`Capture job ${input.ownerId} not found`);
      }
      job = mapCaptureJob(jobResult.rows[0]);
      if (
        job.pageId !== input.pageId ||
        job.ofapiAccountId !== input.ofapiAccountId ||
        job.budgetScope !== input.budgetScope ||
        job.originPrincipalId !== principalId ||
        job.state !== "leased" ||
        job.leaseToken !== (input.jobLeaseToken ?? null) ||
        !job.leaseUntil ||
        job.leaseUntil.getTime() <= now.getTime()
      ) {
        throw new OfapiCaptureInvariantError("Capture job ownership or lease changed before admission");
      }
    } else {
      const request = await database.execute<{
        page_id: unknown;
        ofapi_account_id: string;
        principal_user_id: unknown;
        operation: string;
        state: string;
      }>(sql`
        select page_id, ofapi_account_id, principal_user_id, operation, state
        from ofapi_interactive_requests
        where id = ${input.ownerId}::uuid
        for update
      `);
      const row = request.rows[0];
      if (
        !row ||
        asNumber(row.page_id, "page_id") !== input.pageId ||
        row.ofapi_account_id !== input.ofapiAccountId ||
        asNumber(row.principal_user_id, "principal_user_id") !== principalId ||
        row.operation !== input.operation ||
        row.state !== "created" ||
        input.budgetScope !== "interactive"
      ) {
        throw new OfapiCaptureInvariantError("Interactive request ownership changed before admission");
      }
    }

    const activeFloorProbe = await database.execute<{ id: string }>(sql`
      select id::text as id
      from ofapi_request_attempts
      where is_floor_probe = true
        and (
          state in ('reserved', 'dispatching')
          or (state = 'indeterminate' and certainty_resolved_at is null)
        )
      limit 1
    `);

    const storageHealthResult = input.requireFreshStorageHealth === true
      ? await database.execute<{
        healthy: boolean;
        breached: boolean;
        checked_at: string | Date;
        error: string | null;
      }>(sql`
        select healthy, breached, checked_at, error
        from ofapi_storage_health_state
        where id = 1
      `)
      : null;
    const storageHealthRow = storageHealthResult?.rows[0] ?? null;
    const storageHealthCheckedAt = storageHealthRow
      ? asDate(storageHealthRow.checked_at, "storage_health.checked_at")
      : null;
    const storageHealthMaxAgeMs = Math.max(
      0,
      input.storageHealthMaxAgeMs ?? OFAPI_STORAGE_HEALTH_MAX_AGE_MS,
    );
    const storageHealthFresh = storageHealthCheckedAt !== null &&
      now.getTime() - storageHealthCheckedAt.getTime() <= storageHealthMaxAgeMs;
    const storageHealthy = input.requireFreshStorageHealth !== true || (
      storageHealthRow !== null &&
      storageHealthRow.healthy === true &&
      storageHealthRow.breached === false &&
      storageHealthRow.error === null &&
      storageHealthFresh
    );

    const globalSpent = dateOnly(credit.spend_day) === day
      ? asNumber(credit.spent_credits, "spent_credits")
      : 0;
    const scopeSpent = scopeSpentToday(credit, input.budgetScope, day);
    const unsettled = asNumber(credit.governed_unsettled_credits, "governed_unsettled_credits");
    const lastBalance = asNullableNumber(credit.last_balance, "last_balance");
    const lastBalanceAt = asNullableDate(credit.last_balance_at, "last_balance_at");
    const balanceFresh = lastBalanceAt !== null &&
      now.getTime() - lastBalanceAt.getTime() <= Math.max(0, input.balanceMaxAgeMs);
    const floorProbeNotBefore = asNullableDate(
      credit.floor_probe_not_before,
      "floor_probe_not_before",
    );
    const principalBlockedUntil = principal
      ? asNullableDate(principal.blocked_until, "blocked_until")
      : null;
    const principalUsedCalls = principal ? asNumber(principal.used_calls, "used_calls") : 0;
    const principalUsedCredits = principal ? asNumber(principal.used_credits, "used_credits") : 0;

    let isFloorProbe = false;
    let denial: OfapiBudgetDenialReason | null = null;
    if (paused.rows.length > 0) {
      denial = "persistent_pause";
    } else if (!storageHealthy) {
      denial = "storage_unhealthy";
    } else if (principalBlockedUntil && principalBlockedUntil.getTime() > now.getTime()) {
      denial = "principal_storm_block";
    } else if (!balanceFresh || lastBalance === null) {
      const probeEligible = input.allowFloorProbe === true &&
        input.budgetScope === "live" &&
        activeFloorProbe.rows.length === 0 &&
        (!floorProbeNotBefore || floorProbeNotBefore.getTime() <= now.getTime());
      if (probeEligible) {
        isFloorProbe = true;
      } else {
        denial = "balance_stale";
      }
    } else if (lastBalance - unsettled - estimate < creditFloor) {
      denial = "credit_floor";
    } else if (globalSpent + estimate > globalCap) {
      denial = "global_cap";
    } else if (scopeSpent + estimate > scopeCap) {
      denial = "scope_cap";
    } else if (principalUsedCalls + 1 > principalCallCap) {
      denial = "principal_call_cap";
    } else if (principalUsedCredits + estimate > principalCreditCap) {
      denial = "principal_credit_cap";
    } else if (job?.maxCalls !== null && job && job.attemptCount + 1 > job.maxCalls) {
      denial = "job_cap";
    } else if (job?.maxCredits !== null && job && job.spentCredits + estimate > job.maxCredits) {
      denial = "job_cap";
    }

    if (denial) {
      let thresholdCrossing = false;
      if (denial !== "storage_unhealthy" && principalId !== null && principal) {
        const previousDenials = asNumber(
          principal.consecutive_budget_denials,
          "consecutive_budget_denials",
        );
        const nextDenials = previousDenials + 1;
        thresholdCrossing = nextDenials === denialThreshold;
        const nextBlockedUntil = thresholdCrossing
          ? new Date(now.getTime() + denialBlockMs)
          : principalBlockedUntil;
        await database.execute(sql`
          update ofapi_principal_budget_state
          set consecutive_budget_denials = ${nextDenials},
              blocked_until = ${nextBlockedUntil},
              last_denial_reason = ${denial},
              last_denial_at = ${now},
              updated_at = ${now}
          where principal_user_id = ${principalId}
        `);
      }
      const retryAt = resolveDenialRetryAt(denial, now, {
        principalBlockedUntil,
        floorProbeNotBefore,
      });
      await recordBudgetDenial(database, {
        day,
        scope: input.budgetScope,
        pageId: input.pageId,
        principalUserId: principalId,
        reason: denial,
        thresholdCrossing,
        now,
      });
      await parkDeniedOwner(database, input, denial, retryAt, now);
      return { admitted: false, reason: denial, retryAt };
    }

    const ownerAttempts = await database.execute<{ attempt_no: unknown }>(sql`
      select coalesce(max(owner_attempt_no), 0) + 1 as attempt_no
      from ofapi_request_attempts
      where owner_kind = ${input.ownerKind} and owner_id = ${input.ownerId}::uuid
    `);
    const ownerAttemptNo = asNumber(ownerAttempts.rows[0]?.attempt_no ?? 1, "attempt_no");
    const requestFingerprint = hashOfapiCaptureValue(input.requestShape);
    const admissionSnapshot = {
      version: input.policyVersion ?? OFAPI_CAPTURE_POLICY_VERSION,
      globalCap,
      globalSpentBefore: globalSpent,
      scopeCap,
      scopeSpentBefore: scopeSpent,
      creditFloor,
      lastBalance,
      unsettledBefore: unsettled,
      principalCallCap,
      principalCreditCap,
      principalUsedCallsBefore: principalUsedCalls,
      principalUsedCreditsBefore: principalUsedCredits,
      isFloorProbe,
      storageHealthRequired: input.requireFreshStorageHealth === true,
      storageHealthCheckedAt,
    };

    await database.execute(sql`
      update ofapi_credit_state
      set spend_day = ${day}::date,
          spent_credits = ${globalSpent + estimate},
          governed_scope_day = ${day}::date,
          live_spent_credits = case
            when ${input.budgetScope} = 'live' then
              ${dateOnly(credit.governed_scope_day) === day ? asNumber(credit.live_spent_credits, "live_spent_credits") : 0}::int + ${estimate}::int
            else ${dateOnly(credit.governed_scope_day) === day ? asNumber(credit.live_spent_credits, "live_spent_credits") : 0}
          end,
          interactive_spent_credits = case
            when ${input.budgetScope} = 'interactive' then
              ${dateOnly(credit.governed_scope_day) === day ? asNumber(credit.interactive_spent_credits, "interactive_spent_credits") : 0}::int + ${estimate}::int
            else ${dateOnly(credit.governed_scope_day) === day ? asNumber(credit.interactive_spent_credits, "interactive_spent_credits") : 0}
          end,
          bulk_spent_credits = case
            when ${input.budgetScope} = 'bulk' then
              ${dateOnly(credit.governed_scope_day) === day ? asNumber(credit.bulk_spent_credits, "bulk_spent_credits") : 0}::int + ${estimate}::int
            else ${dateOnly(credit.governed_scope_day) === day ? asNumber(credit.bulk_spent_credits, "bulk_spent_credits") : 0}
          end,
          governed_unsettled_credits = governed_unsettled_credits + ${estimate},
          floor_probe_not_before = case
            when ${isFloorProbe} then ${new Date(now.getTime() + Math.max(60_000, input.floorProbeCooldownMs ?? 60 * 60 * 1000))}
            else floor_probe_not_before
          end,
          updated_at = ${now}
      where id = 1
    `);

    if (principalId !== null && principalWindow) {
      await database.execute(sql`
        update ofapi_principal_budget_state
        set used_calls = used_calls + 1,
            used_credits = used_credits + ${estimate},
            consecutive_budget_denials = 0,
            blocked_until = null,
            updated_at = ${now}
        where principal_user_id = ${principalId}
          and window_started_at = ${principalWindow}
      `);
    }

    await database.execute(sql`
      insert into ofapi_request_attempts (
        id, owner_kind, owner_id, capture_job_id, interactive_request_id,
        owner_attempt_no, page_id, ofapi_account_id, origin_principal_id,
        budget_scope, reservation_day, deadline_at, admission_snapshot, operation,
        endpoint_class, egress_key, method, request_semantics,
        request_fingerprint, is_floor_probe, principal_window_started_at,
        state, parser_outcome, credit_state, reserved_credits,
        fence_token, job_lease_token, surface, serving_mode, fallback_reason,
        policy_version, source_contract_version, parser_version,
        reserved_at, updated_at
      ) values (
        ${attemptId}::uuid,
        ${input.ownerKind},
        ${input.ownerId}::uuid,
        ${input.ownerKind === "capture_job" ? input.ownerId : null}::uuid,
        ${input.ownerKind === "interactive_request" ? input.ownerId : null}::uuid,
        ${ownerAttemptNo},
        ${input.pageId},
        ${input.ofapiAccountId},
        ${principalId},
        ${input.budgetScope},
        ${day}::date,
        ${input.deadlineAt},
        ${JSON.stringify(admissionSnapshot)}::jsonb,
        ${input.operation},
        ${input.endpointClass},
        ${input.egressKey},
        ${input.method},
        ${input.requestSemantics},
        ${requestFingerprint},
        ${isFloorProbe},
        ${principalWindow},
        'reserved',
        'pending',
        'reserved',
        ${estimate},
        ${fenceToken}::uuid,
        ${input.jobLeaseToken ?? null}::uuid,
        ${input.surface ?? null},
        ${input.servingMode ?? null},
        ${input.fallbackReason ?? null},
        ${input.policyVersion ?? OFAPI_CAPTURE_POLICY_VERSION},
        ${input.sourceContractVersion ?? OFAPI_CAPTURE_SOURCE_CONTRACT_VERSION},
        ${input.parserVersion ?? OFAPI_CAPTURE_PARSER_VERSION},
        ${now},
        ${now}
      )
    `);

    if (input.ownerKind === "capture_job") {
      await database.execute(sql`
        update ofapi_capture_jobs
        set attempt_count = attempt_count + 1,
            reason_code = null,
            reason_message = null,
            row_version = row_version + 1,
            updated_at = ${now}
        where id = ${input.ownerId}::uuid
      `);
    } else {
      await database.execute(sql`
        update ofapi_interactive_requests
        set state = 'attempt_reserved',
            row_version = row_version + 1,
            updated_at = ${now}
        where id = ${input.ownerId}::uuid
      `);
    }

    return {
      admitted: true,
      attemptId,
      fenceToken,
      ownerAttemptNo,
      isFloorProbe,
    };
  });
}

export async function markOfapiAttemptDispatching(
  db: Database,
  input: {
    attemptId: string;
    fenceToken: string;
    jobLeaseToken?: string | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = await db.execute<{ id: string }>(sql`
    update ofapi_request_attempts attempt
    set state = 'dispatching',
        dispatch_started_at = ${now},
        updated_at = ${now}
    where attempt.id = ${input.attemptId}::uuid
      and attempt.fence_token = ${input.fenceToken}::uuid
      and attempt.state = 'reserved'
      and attempt.deadline_at > ${now}
      and not exists (
        select 1
        from ofapi_capture_controls control
        where control.paused = true
          and control.control_key in (
            'global',
            ('page:' || attempt.page_id::text),
            ('scope:' || attempt.budget_scope),
            ('operation:' || attempt.operation)
          )
      )
      and (
        (
          attempt.owner_kind = 'interactive_request'
          and attempt.interactive_request_id = attempt.owner_id
          and exists (
            select 1
            from ofapi_interactive_requests request
            where request.id = attempt.interactive_request_id
              and request.state = 'attempt_reserved'
          )
        ) or (
          attempt.owner_kind = 'capture_job'
          and attempt.capture_job_id = attempt.owner_id
          and attempt.job_lease_token = ${input.jobLeaseToken ?? null}::uuid
          and exists (
            select 1
            from ofapi_capture_jobs job
            where job.id = attempt.capture_job_id
              and job.state = 'leased'
              and job.lease_token = attempt.job_lease_token
              and job.lease_until > ${now}
          )
        )
      )
    returning attempt.id::text as id
  `);
  return result.rows.length === 1;
}

async function adjustReservationCounters(
  db: Database,
  input: {
    reservationDay: string;
    budgetScope: OfapiBudgetScope;
    reservedCredits: number;
    principalId: number | null;
    principalWindowStartedAt: Date | null;
    creditDelta: number;
    releaseReservation: boolean;
    balanceAfter?: number | null;
    responseObservedAt?: Date | null;
    now: Date;
  },
) {
  const scopeDelta = input.releaseReservation
    ? -input.reservedCredits
    : input.creditDelta;
  const globalDelta = scopeDelta;
  const unsettledDelta = input.releaseReservation ? -input.reservedCredits : 0;
  const balance = input.balanceAfter === null || input.balanceAfter === undefined
    ? null
    : Math.round(input.balanceAfter);
  const responseObservedAt = input.responseObservedAt ?? null;

  await db.execute(sql`
    update ofapi_credit_state
    set spent_credits = case
          when spend_day = ${input.reservationDay}::date
            then greatest(0, spent_credits + ${globalDelta})
          else spent_credits
        end,
        live_spent_credits = case
          when governed_scope_day = ${input.reservationDay}::date and ${input.budgetScope} = 'live'
            then greatest(0, live_spent_credits + ${scopeDelta})
          else live_spent_credits
        end,
        interactive_spent_credits = case
          when governed_scope_day = ${input.reservationDay}::date and ${input.budgetScope} = 'interactive'
            then greatest(0, interactive_spent_credits + ${scopeDelta})
          else interactive_spent_credits
        end,
        bulk_spent_credits = case
          when governed_scope_day = ${input.reservationDay}::date and ${input.budgetScope} = 'bulk'
            then greatest(0, bulk_spent_credits + ${scopeDelta})
          else bulk_spent_credits
        end,
        governed_unsettled_credits = greatest(
          0,
          governed_unsettled_credits + ${unsettledDelta}
        ),
        last_balance = case
          when ${balance}::int is null then last_balance
          when last_balance_at is null or last_balance_at <= ${responseObservedAt}
            then ${balance}::int
          else last_balance
        end,
        last_balance_at = case
          when ${balance}::int is null then last_balance_at
          when last_balance_at is null or last_balance_at <= ${responseObservedAt}
            then ${responseObservedAt}
          else last_balance_at
        end,
        updated_at = ${input.now}
    where id = 1
  `);

  if (input.principalId !== null && input.principalWindowStartedAt) {
    await db.execute(sql`
      update ofapi_principal_budget_state
      set used_calls = greatest(0, used_calls - ${input.releaseReservation ? 1 : 0}),
          used_credits = greatest(0, used_credits + ${scopeDelta}),
          updated_at = ${input.now}
      where principal_user_id = ${input.principalId}
        and window_started_at = ${input.principalWindowStartedAt}
    `);
  }
}

interface AttemptControlRow extends Record<string, unknown> {
  id: string;
  owner_kind: "capture_job" | "interactive_request";
  owner_id: string;
  capture_job_id: string | null;
  interactive_request_id: string | null;
  page_id: unknown;
  ofapi_account_id: string;
  origin_principal_id: unknown;
  budget_scope: OfapiBudgetScope;
  reservation_day: string | Date;
  principal_window_started_at: string | Date | null;
  operation: string;
  state: OfapiRequestAttemptState;
  request_semantics: "safe_read" | "stateful";
  reserved_credits: unknown;
  fence_token: string;
  job_lease_token: string | null;
  response_observation_id: unknown;
  response_observation_received_at: string | Date | null;
  response_observed_at: string | Date | null;
  credit_state: "reserved" | "settled" | "released" | "indeterminate";
  settled_credits: unknown;
}

async function lockAttempt(db: Database, attemptId: string) {
  const result = await db.execute<AttemptControlRow>(sql`
    select *
    from ofapi_request_attempts
    where id = ${attemptId}::uuid
    for update
  `);
  return result.rows[0] ?? null;
}

export async function releaseOfapiAttemptPreDispatch(
  db: Database,
  input: {
    attemptId: string;
    fenceToken: string;
    reasonCode: string;
    retryAt?: Date | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    // Preserve the global lock order used by admission and settlement.
    await database.execute(sql`select id from ofapi_credit_state where id = 1 for update`);
    const preflight = await database.execute<{
      origin_principal_id: unknown;
      principal_window_started_at: string | Date | null;
    }>(sql`
      select origin_principal_id, principal_window_started_at
      from ofapi_request_attempts
      where id = ${input.attemptId}::uuid
    `);
    const principalId = asNullableNumber(
      preflight.rows[0]?.origin_principal_id,
      "origin_principal_id",
    );
    if (principalId !== null) {
      await database.execute(sql`
        select principal_user_id
        from ofapi_principal_budget_state
        where principal_user_id = ${principalId}
        for update
      `);
    }
    const attempt = await lockAttempt(database, input.attemptId);
    if (!attempt || attempt.fence_token !== input.fenceToken || attempt.state !== "reserved") {
      return false;
    }
    const reservedCredits = asNumber(attempt.reserved_credits, "reserved_credits");
    const principalWindow = asNullableDate(
      attempt.principal_window_started_at,
      "principal_window_started_at",
    );
    await adjustReservationCounters(database, {
      reservationDay: dateOnly(attempt.reservation_day)!,
      budgetScope: attempt.budget_scope,
      reservedCredits,
      principalId,
      principalWindowStartedAt: principalWindow,
      creditDelta: 0,
      releaseReservation: true,
      now,
    });

    await database.execute(sql`
      update ofapi_request_attempts
      set state = 'released_pre_dispatch',
          credit_state = 'released',
          finished_at = ${now},
          certainty_resolved_at = ${now},
          certainty_resolution = ${input.reasonCode},
          updated_at = ${now}
      where id = ${input.attemptId}::uuid
        and state = 'reserved'
        and fence_token = ${input.fenceToken}::uuid
    `);

    if (attempt.owner_kind === "capture_job") {
      const retryAt = input.retryAt ?? null;
      await database.execute(sql`
        update ofapi_capture_jobs
        set state = ${retryAt ? "retry_wait" : "blocked"},
            next_attempt_at = coalesce(${retryAt}, next_attempt_at),
            reason_code = ${input.reasonCode},
            reason_message = 'Attempt released before dispatch',
            lease_owner = null,
            lease_token = null,
            lease_until = null,
            row_version = row_version + 1,
            updated_at = ${now}
        where id = ${attempt.owner_id}::uuid
      `);
    } else {
      await database.execute(sql`
        update ofapi_interactive_requests
        set state = 'failed',
            error_code = ${input.reasonCode},
            completed_at = ${now},
            row_version = row_version + 1,
            updated_at = ${now}
        where id = ${attempt.owner_id}::uuid
      `);
    }
    return true;
  });
}

export type OfapiIndeterminateOutcome = "vendor_slow" | "transport" | "capture_uncommitted";

export async function markOfapiAttemptIndeterminate(
  db: Database,
  input: {
    attemptId: string;
    fenceToken: string;
    outcome: OfapiIndeterminateOutcome;
    responseObservedAt?: Date | null;
    details?: Record<string, unknown>;
    /** Safe reads may be retried after recording the uncertain billed attempt. */
    retrySafeReadAt?: Date | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  if (input.outcome === "capture_uncommitted" && !input.responseObservedAt) {
    throw new OfapiCaptureInvariantError("capture_uncommitted requires responseObservedAt");
  }
  if (input.retrySafeReadAt && input.retrySafeReadAt <= now) {
    throw new OfapiCaptureInvariantError("Safe-read retry must be scheduled in the future");
  }
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await database.execute(sql`select id from ofapi_credit_state where id = 1 for update`);
    const attempt = await lockAttempt(database, input.attemptId);
    if (!attempt || attempt.fence_token !== input.fenceToken || attempt.state !== "dispatching") {
      return false;
    }
    const reservedCredits = asNumber(attempt.reserved_credits, "reserved_credits");
    if (input.retrySafeReadAt && attempt.request_semantics !== "safe_read") {
      throw new OfapiCaptureInvariantError("Stateful indeterminate attempts cannot auto-retry");
    }
    // The hourly balance reconciler must see possibly billed dispatches as
    // known spend immediately. A later resolution appends an adjustment;
    // there is never a second settlement row for the attempt.
    await database.execute(sql`
      insert into ofapi_credit_ledger (
        occurred_at, source, operation, page_id, http_status, credits,
        estimated, balance_after, request_id, details, actor_user_id,
        attempt_id, attempt_entry_phase
      ) values (
        ${now},
        'rest',
        ${attempt.operation},
        ${asNumber(attempt.page_id, "page_id")},
        null,
        ${reservedCredits},
        true,
        null,
        ${input.attemptId},
        ${JSON.stringify({
          certainty: "indeterminate",
          outcome: input.outcome,
          ...(input.details ?? {}),
        })}::jsonb,
        ${asNullableNumber(attempt.origin_principal_id, "origin_principal_id")},
        ${input.attemptId}::uuid,
        'settlement'
      )
      on conflict (attempt_id, attempt_entry_phase)
        where attempt_id is not null
      do nothing
    `);
    await database.execute(sql`
      update ofapi_request_attempts
      set state = 'indeterminate',
          dispatch_outcome = ${input.outcome},
          credit_state = ${input.retrySafeReadAt ? "settled" : "indeterminate"},
          settled_credits = ${input.retrySafeReadAt ? reservedCredits : null},
          credit_estimated = ${input.retrySafeReadAt ? "true" : "false"}::boolean,
          response_observed_at = ${input.responseObservedAt ?? null},
          finished_at = ${now},
          certainty_resolved_at = ${input.retrySafeReadAt ? now : null},
          certainty_resolution = ${input.retrySafeReadAt
            ? "safe_read_retry_assumed_billed"
            : null},
          updated_at = ${now}
      where id = ${input.attemptId}::uuid
        and state = 'dispatching'
        and fence_token = ${input.fenceToken}::uuid
    `);
    if (input.retrySafeReadAt) {
      // A safe GET can be repeated, but its first dispatch may still have
      // consumed the reserved credit. Resolve it conservatively as billed so
      // it no longer occupies the owner's active-attempt fence while every
      // budget counter continues to include the charge.
      await database.execute(sql`
        update ofapi_credit_state
        set governed_unsettled_credits = greatest(
              0,
              governed_unsettled_credits - ${reservedCredits}
            ),
            updated_at = ${now}
        where id = 1
      `);
    }
    if (attempt.owner_kind === "capture_job") {
      await database.execute(sql`
        update ofapi_capture_jobs
        set state = ${input.retrySafeReadAt ? "retry_wait" : "blocked"},
            next_attempt_at = coalesce(${input.retrySafeReadAt ?? null}, next_attempt_at),
            reason_code = ${input.retrySafeReadAt
              ? "indeterminate_safe_read_retry"
              : "indeterminate"},
            reason_message = ${`Dispatch certainty unresolved: ${input.outcome}`},
            spent_credits = spent_credits + ${reservedCredits},
            dispatch_count = dispatch_count + 1,
            lease_owner = null,
            lease_token = null,
            lease_until = null,
            row_version = row_version + 1,
            updated_at = ${now}
        where id = ${attempt.owner_id}::uuid
      `);
    } else {
      await database.execute(sql`
        update ofapi_interactive_requests
        set state = 'indeterminate',
            error_code = ${input.outcome},
            completed_at = ${now},
            row_version = row_version + 1,
            updated_at = ${now}
        where id = ${attempt.owner_id}::uuid
      `);
    }
    return true;
  });
}

/**
 * Planner-side crash recovery. A lease that expired before dispatch is safe
 * to release and retry; one that crossed the dispatch CAS is financially
 * uncertain and is parked for reconciliation. No recovery path performs a
 * vendor request.
 */
export async function recoverStaleOfapiCaptureWork(
  db: Database,
  input?: { now?: Date; limit?: number },
) {
  const now = input?.now ?? new Date();
  const limit = Math.max(1, Math.min(1_000, Math.trunc(input?.limit ?? 100)));
  const attempts = await db.execute<{
    id: string;
    fence_token: string;
    state: "reserved" | "dispatching";
    owner_kind: "capture_job" | "interactive_request";
    is_floor_probe: boolean;
    request_semantics: "safe_read" | "stateful";
  }>(sql`
    select attempt.id::text as id,
           attempt.fence_token::text as fence_token,
           attempt.state,
           attempt.owner_kind,
           attempt.is_floor_probe,
           attempt.request_semantics
    from ofapi_request_attempts attempt
    left join ofapi_capture_jobs job
      on job.id = attempt.capture_job_id
    where (
        (
          attempt.owner_kind = 'capture_job'
          and job.state = 'leased'
          and job.lease_until <= ${now}
        ) or (
          attempt.owner_kind = 'interactive_request'
          and attempt.deadline_at <= ${now}
        )
      )
      and attempt.state in ('reserved', 'dispatching')
    order by coalesce(job.lease_until, attempt.deadline_at), attempt.id
    limit ${limit}
  `);

  let released = 0;
  let indeterminate = 0;
  for (const attempt of attempts.rows) {
    if (attempt.state === "reserved") {
      if (await releaseOfapiAttemptPreDispatch(db, {
        attemptId: attempt.id,
        fenceToken: attempt.fence_token,
        reasonCode: "lease_expired",
        retryAt: now,
        now,
      })) {
        released += 1;
      }
    } else {
      const safelyResolveFloorProbe = attempt.is_floor_probe &&
        attempt.request_semantics === "safe_read";
      if (await markOfapiAttemptIndeterminate(db, {
        attemptId: attempt.id,
        fenceToken: attempt.fence_token,
        outcome: "transport",
        details: {
          recovery: attempt.owner_kind === "capture_job"
            ? "expired_job_lease"
            : "expired_interactive_deadline",
          floorProbe: attempt.is_floor_probe,
        },
        ...(safelyResolveFloorProbe
          ? { retrySafeReadAt: new Date(now.getTime() + OFAPI_DEADLINE_RECHECK_MS) }
          : {}),
        now,
      })) {
        indeterminate += 1;
      }
    }
  }

  const requeued = await db.execute<{ id: string }>(sql`
    update ofapi_capture_jobs job
    set state = 'ready',
        next_attempt_at = ${now},
        reason_code = 'lease_expired_before_attempt',
        reason_message = null,
        lease_owner = null,
        lease_token = null,
        lease_until = null,
        row_version = row_version + 1,
        updated_at = ${now}
    where job.state = 'leased'
      and job.lease_until <= ${now}
      and not exists (
        select 1
        from ofapi_request_attempts attempt
        where attempt.capture_job_id = job.id
          and attempt.state in ('reserved', 'dispatching', 'indeterminate')
      )
    returning job.id::text as id
  `);
  return { released, indeterminate, requeued: requeued.rows.length };
}

export interface CaptureOfapiAttemptResponseInput {
  attemptId: string;
  fenceToken: string;
  responseObservedAt: Date;
  httpStatus: number;
  httpOutcome: OfapiHttpOutcome;
  responseHeaders: Record<string, string>;
  bodyBytes: Buffer;
  request: Record<string, unknown>;
  producer: string;
  observationKind: string;
  settledCredits?: number | null;
  balanceAfter?: number | null;
  now?: Date;
}

function encodeRawBody(bytes: Buffer) {
  const utf8 = bytes.toString("utf8");
  const roundTrip = Buffer.from(utf8, "utf8");
  if (roundTrip.equals(bytes)) {
    return { bodyEncoding: "utf8" as const, body: utf8 };
  }
  return { bodyEncoding: "base64" as const, body: bytes.toString("base64") };
}

export async function captureOfapiAttemptResponse(
  db: Database,
  input: CaptureOfapiAttemptResponseInput,
) {
  const now = input.now ?? new Date();
  const payloadHash = createHash("sha256").update(input.bodyBytes).digest();
  const encoded = encodeRawBody(input.bodyBytes);
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const captureContext = await database.execute<{
      page_id: unknown;
      ofapi_account_id: string;
      origin_principal_id: unknown;
    }>(sql`
      select page_id, ofapi_account_id, origin_principal_id
      from ofapi_request_attempts
      where id = ${input.attemptId}::uuid
        and fence_token = ${input.fenceToken}::uuid
    `);
    const context = captureContext.rows[0];
    if (!context) {
      throw new OfapiCaptureInvariantError("Attempt fence changed before observation capture");
    }
    // Observation allocation/claim is part of this transaction. No response
    // can become visible to the caller before all following state settles.
    const observation = await insertObservation(database, {
      source: "ofapi_capture",
      producer: input.producer,
      platform: "onlyfans",
      accountId: asNumber(context.page_id, "page_id"),
      nativeAccountRef: context.ofapi_account_id,
      kind: input.observationKind,
      payload: {
        attemptId: input.attemptId,
        request: input.request,
        response: {
          status: input.httpStatus,
          headers: input.responseHeaders,
          receivedAt: input.responseObservedAt.toISOString(),
          ...encoded,
        },
        sourceContractVersion: OFAPI_CAPTURE_SOURCE_CONTRACT_VERSION,
      },
      payloadHash,
      idempotencyKey: input.attemptId,
      observedAt: input.responseObservedAt,
      actorPrincipalId: asNullableNumber(
        context.origin_principal_id,
        "origin_principal_id",
      ),
    });
    if (!observation.inserted) {
      const existingPayload = await database.execute<{ payload_hash: Buffer }>(sql`
        select payload_hash
        from observations
        where id = ${observation.observationId}
          and received_at = ${observation.receivedAt}
      `);
      if (!existingPayload.rows[0]?.payload_hash?.equals(payloadHash)) {
        throw new OfapiCaptureInvariantError(
          `Attempt ${input.attemptId} was captured with different raw bytes`,
        );
      }
    }

    await database.execute(sql`select id from ofapi_credit_state where id = 1 for update`);
    const preflight = await database.execute<{
      origin_principal_id: unknown;
    }>(sql`
      select origin_principal_id
      from ofapi_request_attempts
      where id = ${input.attemptId}::uuid
    `);
    const principalId = asNullableNumber(
      preflight.rows[0]?.origin_principal_id,
      "origin_principal_id",
    );
    if (principalId !== null) {
      await database.execute(sql`
        select principal_user_id
        from ofapi_principal_budget_state
        where principal_user_id = ${principalId}
        for update
      `);
    }
    const attempt = await lockAttempt(database, input.attemptId);
    if (!attempt || attempt.fence_token !== input.fenceToken) {
      throw new OfapiCaptureInvariantError("Attempt fence changed before response capture");
    }
    if (attempt.state === "response_captured") {
      const existingId = asNullableNumber(
        attempt.response_observation_id,
        "response_observation_id",
      );
      if (existingId !== observation.observationId) {
        throw new OfapiCaptureInvariantError("Captured attempt points at a different observation");
      }
      return {
        observationId: existingId,
        receivedAt: asDate(
          attempt.response_observation_received_at,
          "response_observation_received_at",
        ),
        duplicate: true,
      };
    }
    if (
      attempt.state !== "dispatching" &&
      !(attempt.state === "indeterminate" && attempt.credit_state === "indeterminate")
    ) {
      throw new OfapiCaptureInvariantError(
        `Attempt ${input.attemptId} cannot capture from ${attempt.state}`,
      );
    }

    const reservedCredits = asNumber(attempt.reserved_credits, "reserved_credits");
    const settledCredits = input.settledCredits === null || input.settledCredits === undefined
      ? reservedCredits
      : normalizeCredits(input.settledCredits);
    const estimated = input.settledCredits === null || input.settledCredits === undefined;
    const priorIndeterminate = attempt.state === "indeterminate";
    if (!priorIndeterminate) {
      await database.execute(sql`
        insert into ofapi_credit_ledger (
          occurred_at, source, operation, page_id, http_status, credits,
          estimated, balance_after, request_id, details, actor_user_id,
          attempt_id, attempt_entry_phase
        ) values (
          ${input.responseObservedAt},
          'rest',
          ${attempt.operation},
          ${asNumber(attempt.page_id, "page_id")},
          ${input.httpStatus},
          ${settledCredits},
          ${estimated},
          ${input.balanceAfter ?? null},
          ${input.attemptId},
          ${JSON.stringify({ certainty: "captured" })}::jsonb,
          ${principalId},
          ${input.attemptId}::uuid,
          'settlement'
        )
      `);
    } else if (settledCredits !== reservedCredits) {
      await database.execute(sql`
        insert into ofapi_credit_ledger (
          occurred_at, source, operation, page_id, http_status, credits,
          estimated, balance_after, request_id, details, actor_user_id,
          attempt_id, attempt_entry_phase
        ) values (
          ${input.responseObservedAt},
          'adjustment',
          ${attempt.operation},
          ${asNumber(attempt.page_id, "page_id")},
          ${input.httpStatus},
          ${settledCredits - reservedCredits},
          false,
          ${input.balanceAfter ?? null},
          ${input.attemptId},
          ${JSON.stringify({ certainty: "late_response", reservedCredits, settledCredits })}::jsonb,
          ${principalId},
          ${input.attemptId}::uuid,
          'certainty_adjustment'
        )
      `);
    }

    const principalWindow = asNullableDate(
      attempt.principal_window_started_at,
      "principal_window_started_at",
    );
    await adjustReservationCounters(database, {
      reservationDay: dateOnly(attempt.reservation_day)!,
      budgetScope: attempt.budget_scope,
      reservedCredits,
      principalId,
      principalWindowStartedAt: principalWindow,
      creditDelta: settledCredits - reservedCredits,
      releaseReservation: false,
      balanceAfter: input.balanceAfter ?? null,
      responseObservedAt: input.responseObservedAt,
      now,
    });
    // Settlement always resolves the outstanding floor reservation.
    await database.execute(sql`
      update ofapi_credit_state
      set governed_unsettled_credits = greatest(
            0,
            governed_unsettled_credits - ${reservedCredits}
          ),
          updated_at = ${now}
      where id = 1
    `);

    await database.execute(sql`
      update ofapi_request_attempts
      set state = 'response_captured',
          dispatch_outcome = 'response_received',
          http_outcome = ${input.httpOutcome},
          parser_outcome = 'pending',
          credit_state = 'settled',
          settled_credits = ${settledCredits},
          credit_estimated = ${estimated},
          balance_after = ${input.balanceAfter ?? null},
          response_observation_id = ${observation.observationId},
          response_observation_received_at = ${observation.receivedAt},
          response_observed_at = ${input.responseObservedAt},
          response_captured_at = ${now},
          finished_at = ${now},
          certainty_resolved_at = case when state = 'indeterminate' then ${now} else certainty_resolved_at end,
          certainty_resolution = case when state = 'indeterminate' then 'late_response' else certainty_resolution end,
          updated_at = ${now}
      where id = ${input.attemptId}::uuid
        and fence_token = ${input.fenceToken}::uuid
    `);

    if (attempt.owner_kind === "capture_job") {
      await database.execute(sql`
        update ofapi_capture_jobs
        set state = 'awaiting_parse',
            pending_observation_id = ${observation.observationId},
            pending_observation_received_at = ${observation.receivedAt},
            spent_credits = spent_credits + ${settledCredits},
            dispatch_count = dispatch_count + 1,
            reason_code = null,
            reason_message = null,
            row_version = row_version + 1,
            updated_at = ${now}
        where id = ${attempt.owner_id}::uuid
      `);
    } else {
      await database.execute(sql`
        update ofapi_interactive_requests
        set state = 'response_captured',
            response_observation_id = ${observation.observationId},
            response_observation_received_at = ${observation.receivedAt},
            http_outcome = ${input.httpOutcome},
            row_version = row_version + 1,
            updated_at = ${now}
        where id = ${attempt.owner_id}::uuid
      `);
    }

    return {
      observationId: observation.observationId,
      receivedAt: observation.receivedAt,
      duplicate: !observation.inserted,
    };
  });
}

/**
 * Applies provider credit metadata only after the raw response observation is
 * durable. Capture initially settles the reserved estimate so no reservation
 * can leak; this local correction appends a delta and refreshes the balance
 * without another vendor request.
 */
export async function reconcileOfapiCapturedAttemptCredit(
  db: Database,
  input: {
    attemptId: string;
    actualCredits: number;
    balanceAfter?: number | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const actualCredits = normalizeCredits(input.actualCredits);
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await database.execute(sql`select id from ofapi_credit_state where id = 1 for update`);
    const preflight = await database.execute<{ origin_principal_id: unknown }>(sql`
      select origin_principal_id
      from ofapi_request_attempts
      where id = ${input.attemptId}::uuid
    `);
    const principalId = asNullableNumber(
      preflight.rows[0]?.origin_principal_id,
      "origin_principal_id",
    );
    if (principalId !== null) {
      await database.execute(sql`
        select principal_user_id
        from ofapi_principal_budget_state
        where principal_user_id = ${principalId}
        for update
      `);
    }
    const attempt = await lockAttempt(database, input.attemptId);
    if (
      !attempt ||
      attempt.state !== "response_captured" ||
      attempt.credit_state !== "settled"
    ) {
      return false;
    }
    const priorCredits = asNumber(attempt.settled_credits, "settled_credits");
    const alreadyExact = await database.execute<{ credit_estimated: boolean }>(sql`
      select credit_estimated
      from ofapi_request_attempts
      where id = ${input.attemptId}::uuid
    `);
    if (alreadyExact.rows[0]?.credit_estimated === false) {
      if (priorCredits !== actualCredits) {
        throw new OfapiCaptureInvariantError(
          `Attempt ${input.attemptId} credit metadata changed after reconciliation`,
        );
      }
      return true;
    }

    const responseObservedAt = asNullableDate(
      attempt.response_observed_at,
      "response_observed_at",
    ) ?? now;
    const delta = actualCredits - priorCredits;
    if (delta !== 0) {
      await database.execute(sql`
        insert into ofapi_credit_ledger (
          occurred_at, source, operation, page_id, http_status, credits,
          estimated, balance_after, request_id, details, actor_user_id,
          attempt_id, attempt_entry_phase
        ) values (
          ${responseObservedAt},
          'adjustment',
          ${attempt.operation},
          ${asNumber(attempt.page_id, "page_id")},
          null,
          ${delta},
          false,
          ${input.balanceAfter ?? null},
          ${input.attemptId},
          ${JSON.stringify({ certainty: "captured_meta", priorCredits, actualCredits })}::jsonb,
          ${principalId},
          ${input.attemptId}::uuid,
          'certainty_adjustment'
        )
      `);
    }

    await adjustReservationCounters(database, {
      reservationDay: dateOnly(attempt.reservation_day)!,
      budgetScope: attempt.budget_scope,
      reservedCredits: asNumber(attempt.reserved_credits, "reserved_credits"),
      principalId,
      principalWindowStartedAt: asNullableDate(
        attempt.principal_window_started_at,
        "principal_window_started_at",
      ),
      creditDelta: delta,
      releaseReservation: false,
      balanceAfter: input.balanceAfter ?? null,
      responseObservedAt,
      now,
    });
    await database.execute(sql`
      update ofapi_request_attempts
      set settled_credits = ${actualCredits},
          credit_estimated = false,
          balance_after = ${input.balanceAfter ?? null},
          updated_at = ${now}
      where id = ${input.attemptId}::uuid
    `);
    if (attempt.owner_kind === "capture_job" && delta !== 0) {
      await database.execute(sql`
        update ofapi_capture_jobs
        set spent_credits = greatest(0, spent_credits + ${delta}),
            row_version = row_version + 1,
            updated_at = ${now}
        where id = ${attempt.owner_id}::uuid
      `);
    }
    return true;
  });
}

export type OfapiCaptureParseDisposition =
  | {
    kind: "progress";
    cursor: Record<string, unknown>;
    acceptedItems: number;
    acceptedPages?: number;
  }
  | {
    kind: "retry";
    nextAttemptAt: Date;
    reasonCode: string;
    reasonMessage?: string | null;
    /** Optional monotone protocol state captured from this response. */
    cursor?: Record<string, unknown>;
  }
  | {
    kind: "blocked";
    reasonCode: string;
    reasonMessage?: string | null;
    /** Final local protocol state that explains why owner action is needed. */
    cursor?: Record<string, unknown>;
  }
  | {
    kind: "complete";
    /**
     * Exact coverage row this terminal fact joins onto. It is checked under
     * row lock in the same transaction before either the proof observation or
     * its domain event can be appended.
     */
    expectedSupersedes?: {
      conversationRef: string;
      proof: OfapiMessageCoverageProofReference;
    };
    terminal: {
      producer: string;
      kind: string;
      payload: Record<string, unknown>;
      payloadHash: Buffer;
      idempotencyKey: string;
      observedAt?: Date | null;
      coverage?: {
        conversationRef: string;
        dedupKey: string;
        checkpointDedupKey: string;
        checkpointData?: Record<string, unknown>;
      } | null;
    };
    result?: Record<string, unknown> | null;
  }
  | {
    kind: "parser_failed";
    reasonMessage: string;
  };

export async function settleOfapiCaptureParse(
  db: Database,
  input: {
    jobId: string;
    attemptId: string;
    leaseToken: string;
    observationId: number;
    observationReceivedAt: Date;
    parserOutcome: OfapiParserOutcome;
    rawCount: number;
    acceptedCount: number;
    boundaryDuplicateCount: number;
    explicitlyIrrelevantCount: number;
    rejectedCount: number;
    disposition: OfapiCaptureParseDisposition;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const counts = {
    raw: Math.max(0, Math.trunc(input.rawCount)),
    accepted: Math.max(0, Math.trunc(input.acceptedCount)),
    boundary: Math.max(0, Math.trunc(input.boundaryDuplicateCount)),
    irrelevant: Math.max(0, Math.trunc(input.explicitlyIrrelevantCount)),
    rejected: Math.max(0, Math.trunc(input.rejectedCount)),
  };
  if (
    (input.parserOutcome === "accepted" || input.parserOutcome === "intentional_noop") &&
    (
      counts.raw !== counts.accepted + counts.boundary + counts.irrelevant ||
      counts.rejected !== 0
    )
  ) {
    throw new OfapiCaptureInvariantError("Accepted parse violates the raw item balance");
  }
  if (input.disposition.kind === "retry" && input.disposition.nextAttemptAt <= now) {
    throw new OfapiCaptureInvariantError("I0 retry outcome must be scheduled in the future");
  }

  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const jobResult = await database.execute<Record<string, unknown>>(sql`
      select *
      from ofapi_capture_jobs
      where id = ${input.jobId}::uuid
      for update
    `);
    const row = jobResult.rows[0];
    if (!row) return false;
    const job = mapCaptureJob(row);
    if (
      job.state !== "awaiting_parse" ||
      job.leaseToken !== input.leaseToken ||
      job.pendingObservationId !== input.observationId ||
      job.pendingObservationReceivedAt?.getTime() !== input.observationReceivedAt.getTime()
    ) {
      return false;
    }

    const attemptResult = await database.execute<{
      state: string;
      response_observation_id: unknown;
      response_observation_received_at: string | Date | null;
    }>(sql`
      select state, response_observation_id, response_observation_received_at
      from ofapi_request_attempts
      where id = ${input.attemptId}::uuid
        and capture_job_id = ${input.jobId}::uuid
      for update
    `);
    const attempt = attemptResult.rows[0];
    if (
      !attempt ||
      attempt.state !== "response_captured" ||
      asNumber(attempt.response_observation_id, "response_observation_id") !== input.observationId ||
      asDate(
        attempt.response_observation_received_at,
        "response_observation_received_at",
      ).getTime() !== input.observationReceivedAt.getTime()
    ) {
      return false;
    }

    await database.execute(sql`
      update ofapi_request_attempts
      set parser_outcome = ${input.parserOutcome},
          raw_count = ${counts.raw},
          accepted_count = ${counts.accepted},
          boundary_duplicate_count = ${counts.boundary},
          explicitly_irrelevant_count = ${counts.irrelevant},
          rejected_count = ${counts.rejected},
          updated_at = ${now}
      where id = ${input.attemptId}::uuid
    `);

    switch (input.disposition.kind) {
      case "progress": {
        const cursorHash = hashOfapiCaptureValue(input.disposition.cursor);
        if (cursorHash === job.cursorHash) {
          throw new OfapiCaptureInvariantError("I0 progress outcome did not change the cursor");
        }
        await database.execute(sql`
          update ofapi_capture_jobs
          set state = 'ready',
              cursor = ${JSON.stringify(input.disposition.cursor)}::jsonb,
              cursor_hash = ${cursorHash},
              next_attempt_at = ${now},
              pending_observation_id = null,
              pending_observation_received_at = null,
              accepted_items = accepted_items + ${Math.max(0, Math.trunc(input.disposition.acceptedItems))},
              accepted_pages = accepted_pages + ${Math.max(0, Math.trunc(input.disposition.acceptedPages ?? 1))},
              zero_progress_count = 0,
              reason_code = null,
              reason_message = null,
              lease_owner = null,
              lease_token = null,
              lease_until = null,
              row_version = row_version + 1,
              updated_at = ${now}
          where id = ${input.jobId}::uuid
        `);
        break;
      }
      case "retry": {
        const nextCursor = input.disposition.cursor ?? null;
        const nextCursorHash = nextCursor === null ? null : hashOfapiCaptureValue(nextCursor);
        if (nextCursorHash !== null && nextCursorHash === job.cursorHash) {
          throw new OfapiCaptureInvariantError("I0 retry outcome did not change the cursor");
        }
        await database.execute(sql`
          update ofapi_capture_jobs
          set state = 'retry_wait',
              next_attempt_at = ${input.disposition.nextAttemptAt},
              cursor = coalesce(${nextCursor === null ? null : JSON.stringify(nextCursor)}::jsonb, cursor),
              cursor_hash = coalesce(${nextCursorHash}, cursor_hash),
              pending_observation_id = null,
              pending_observation_received_at = null,
              zero_progress_count = zero_progress_count + 1,
              reason_code = ${input.disposition.reasonCode},
              reason_message = ${input.disposition.reasonMessage ?? null},
              lease_owner = null,
              lease_token = null,
              lease_until = null,
              row_version = row_version + 1,
              updated_at = ${now}
          where id = ${input.jobId}::uuid
        `);
        break;
      }
      case "blocked": {
        const nextCursor = input.disposition.cursor ?? null;
        const nextCursorHash = nextCursor === null ? null : hashOfapiCaptureValue(nextCursor);
        if (nextCursorHash !== null && nextCursorHash === job.cursorHash) {
          throw new OfapiCaptureInvariantError("I0 blocked outcome did not change the cursor");
        }
        await database.execute(sql`
          update ofapi_capture_jobs
          set state = 'blocked',
              cursor = coalesce(${nextCursor === null ? null : JSON.stringify(nextCursor)}::jsonb, cursor),
              cursor_hash = coalesce(${nextCursorHash}, cursor_hash),
              pending_observation_id = null,
              pending_observation_received_at = null,
              zero_progress_count = zero_progress_count + 1,
              reason_code = ${input.disposition.reasonCode},
              reason_message = ${input.disposition.reasonMessage ?? null},
              lease_owner = null,
              lease_token = null,
              lease_until = null,
              row_version = row_version + 1,
              updated_at = ${now}
          where id = ${input.jobId}::uuid
        `);
        break;
      }
      case "complete": {
        const expectedSupersedes = input.disposition.expectedSupersedes ?? null;
        if (expectedSupersedes !== null) {
          if (
            input.disposition.terminal.coverage?.conversationRef !==
              expectedSupersedes.conversationRef
          ) {
            throw new OfapiCaptureInvariantError(
              "Anchor proof expectation does not match the terminal conversation",
            );
          }
          const currentProof = await database.execute<Record<string, unknown>>(sql`
            select *
            from ofapi_message_coverage
            where page_id = ${job.pageId}
              and chat_id = ${expectedSupersedes.conversationRef}
            for update
          `);
          if (!matchesOfapiMessageCoverageProofReference(
            currentProof.rows[0],
            expectedSupersedes.proof,
          )) {
            await database.execute(sql`
              update ofapi_capture_jobs
              set state = 'blocked',
                  pending_observation_id = null,
                  pending_observation_received_at = null,
                  zero_progress_count = zero_progress_count + 1,
                  reason_code = 'anchor_proof_changed',
                  reason_message = 'The continuous proof at the requested anchor changed before completion',
                  lease_owner = null,
                  lease_token = null,
                  lease_until = null,
                  row_version = row_version + 1,
                  updated_at = ${now}
              where id = ${input.jobId}::uuid
            `);
            return true;
          }
        }
        const terminal = await insertObservation(database, {
          source: "ofapi_capture",
          producer: input.disposition.terminal.producer,
          platform: "onlyfans",
          accountId: job.pageId,
          nativeAccountRef: job.ofapiAccountId,
          kind: input.disposition.terminal.kind,
          payload: input.disposition.terminal.payload,
          payloadHash: input.disposition.terminal.payloadHash,
          idempotencyKey: input.disposition.terminal.idempotencyKey,
          observedAt: input.disposition.terminal.observedAt ?? now,
          actorPrincipalId: job.originPrincipalId,
          receivedAt: now,
        });
        if (!terminal.inserted) {
          const existingPayload = await database.execute<{ payload_hash: Buffer }>(sql`
            select payload_hash
            from observations
            where id = ${terminal.observationId}
              and received_at = ${terminal.receivedAt}
          `);
          if (!existingPayload.rows[0]?.payload_hash?.equals(
            input.disposition.terminal.payloadHash,
          )) {
            throw new OfapiCaptureInvariantError(
              `Terminal proof for job ${input.jobId} conflicts with a captured fact`,
            );
          }
        }
        const coverage = input.disposition.terminal.coverage ?? null;
        if (coverage) {
          await appendProjectionOnlyDomainEventsInTransaction(database, job.pageId, [{
            type: "capture.coverage_observed",
            occurredAt: terminal.receivedAt,
            conversationRef: coverage.conversationRef,
            data: {
              ...input.disposition.terminal.payload,
              proofObservationId: terminal.observationId,
              proofObservationReceivedAt: terminal.receivedAt.toISOString(),
            },
            schemaVersion: 1,
            observationId: terminal.observationId,
            dedupKey: coverage.dedupKey,
          }], {
            occurredAt: terminal.receivedAt,
            observationId: terminal.observationId,
            dedupKey: coverage.checkpointDedupKey,
            ...(coverage.checkpointData === undefined
              ? {}
              : { data: coverage.checkpointData }),
          });
        }
        await database.execute(sql`
          update ofapi_capture_jobs
          set state = 'complete',
              pending_observation_id = null,
              pending_observation_received_at = null,
              terminal_observation_id = ${terminal.observationId},
              terminal_observation_received_at = ${terminal.receivedAt},
              result = ${JSON.stringify(input.disposition.result ?? {})}::jsonb,
              completed_at = ${now},
              reason_code = null,
              reason_message = null,
              lease_owner = null,
              lease_token = null,
              lease_until = null,
              row_version = row_version + 1,
              updated_at = ${now}
          where id = ${input.jobId}::uuid
        `);
        break;
      }
      case "parser_failed":
        await database.execute(sql`
          update ofapi_capture_jobs
          set state = 'awaiting_parse',
              reason_code = 'parser_failed',
              reason_message = ${input.disposition.reasonMessage},
              lease_owner = null,
              lease_token = null,
              lease_until = null,
              row_version = row_version + 1,
              updated_at = ${now}
          where id = ${input.jobId}::uuid
        `);
        break;
    }
    return true;
  });
}

export async function completeOfapiInteractiveRequest(
  db: Database,
  input: {
    requestId: string;
    attemptId: string;
    outcome: "served" | "failed";
    parserOutcome: OfapiParserOutcome;
    errorCode?: string | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = await db.execute<{ id: string }>(sql`
    with attempt as (
      update ofapi_request_attempts
      set parser_outcome = ${input.parserOutcome},
          updated_at = ${now}
      where id = ${input.attemptId}::uuid
        and interactive_request_id = ${input.requestId}::uuid
        and state = 'response_captured'
      returning response_observation_id, response_observation_received_at
    )
    update ofapi_interactive_requests request
    set state = ${input.outcome},
        error_code = ${input.errorCode ?? null},
        completed_at = ${now},
        row_version = row_version + 1,
        updated_at = ${now}
    from attempt
    where request.id = ${input.requestId}::uuid
      and request.state = 'response_captured'
      and request.response_observation_id = attempt.response_observation_id
      and request.response_observation_received_at = attempt.response_observation_received_at
    returning request.id::text as id
  `);
  return result.rows.length === 1;
}

export async function resolveOfapiIndeterminateAttempt(
  db: Database,
  input: {
    attemptId: string;
    expectedState?: "indeterminate";
    resolution: "confirmed_billed" | "confirmed_not_billed";
    actualCredits?: number | null;
    actorUserId: number;
    reason: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await database.execute(sql`select id from ofapi_credit_state where id = 1 for update`);
    const preflight = await database.execute<{ origin_principal_id: unknown }>(sql`
      select origin_principal_id from ofapi_request_attempts
      where id = ${input.attemptId}::uuid
    `);
    const principalId = asNullableNumber(
      preflight.rows[0]?.origin_principal_id,
      "origin_principal_id",
    );
    if (principalId !== null) {
      await database.execute(sql`
        select principal_user_id from ofapi_principal_budget_state
        where principal_user_id = ${principalId}
        for update
      `);
    }
    const attempt = await lockAttempt(database, input.attemptId);
    if (
      !attempt ||
      attempt.state !== (input.expectedState ?? "indeterminate") ||
      attempt.credit_state !== "indeterminate"
    ) {
      return false;
    }
    const reservedCredits = asNumber(attempt.reserved_credits, "reserved_credits");
    const billedCredits = input.resolution === "confirmed_not_billed"
      ? 0
      : input.actualCredits === null || input.actualCredits === undefined
        ? reservedCredits
        : normalizeCredits(input.actualCredits);
    const delta = billedCredits - reservedCredits;
    if (delta !== 0) {
      await database.execute(sql`
        insert into ofapi_credit_ledger (
          occurred_at, source, operation, page_id, http_status, credits,
          estimated, request_id, details, actor_user_id,
          attempt_id, attempt_entry_phase
        ) values (
          ${now},
          'adjustment',
          ${attempt.operation},
          ${asNumber(attempt.page_id, "page_id")},
          null,
          ${delta},
          false,
          ${input.attemptId},
          ${JSON.stringify({
            certainty: input.resolution,
            reservedCredits,
            billedCredits,
            reason: input.reason,
          })}::jsonb,
          ${input.actorUserId},
          ${input.attemptId}::uuid,
          'certainty_adjustment'
        )
      `);
    }
    await adjustReservationCounters(database, {
      reservationDay: dateOnly(attempt.reservation_day)!,
      budgetScope: attempt.budget_scope,
      reservedCredits,
      principalId,
      principalWindowStartedAt: asNullableDate(
        attempt.principal_window_started_at,
        "principal_window_started_at",
      ),
      creditDelta: delta,
      releaseReservation: false,
      now,
    });
    await database.execute(sql`
      update ofapi_credit_state
      set governed_unsettled_credits = greatest(
            0,
            governed_unsettled_credits - ${reservedCredits}
          ),
          updated_at = ${now}
      where id = 1
    `);
    await database.execute(sql`
      update ofapi_request_attempts
      set credit_state = ${billedCredits === 0 ? "released" : "settled"},
          settled_credits = ${billedCredits},
          credit_estimated = ${input.actualCredits === null || input.actualCredits === undefined},
          certainty_resolved_at = ${now},
          certainty_resolution = ${input.resolution},
          updated_at = ${now}
      where id = ${input.attemptId}::uuid
        and state = 'indeterminate'
        and certainty_resolved_at is null
    `);
    if (attempt.capture_job_id !== null) {
      let requeuedSafeRead = false;
      if (attempt.request_semantics === "safe_read") {
        const requeued = await database.execute<{ id: string }>(sql`
          update ofapi_capture_jobs
          set state = 'retry_wait',
              next_attempt_at = ${now},
              reason_code = 'operator_reconciled_safe_read',
              reason_message = ${`Attempt certainty resolved: ${input.resolution}`},
              spent_credits = greatest(0, spent_credits + ${delta}),
              row_version = row_version + 1,
              updated_at = ${now}
          where id = ${String(attempt.capture_job_id)}::uuid
            and state = 'blocked'
            and reason_code = 'indeterminate'
          returning id::text as id
        `);
        requeuedSafeRead = requeued.rows.length === 1;
      }
      if (!requeuedSafeRead && delta !== 0) {
        await database.execute(sql`
          update ofapi_capture_jobs
          set spent_credits = greatest(0, spent_credits + ${delta}),
              row_version = row_version + 1,
              updated_at = ${now}
          where id = ${String(attempt.capture_job_id)}::uuid
        `);
      }
    }
    await database.execute(sql`
      insert into ofapi_capture_operator_actions (
        action, target_type, target_ref, expected_state,
        resulting_state, dry_run, actor_user_id, reason, occurred_at
      ) values (
        'resolve_indeterminate',
        'attempt',
        ${input.attemptId},
        'indeterminate',
        ${JSON.stringify({ resolution: input.resolution, billedCredits })}::jsonb,
        false,
        ${input.actorUserId},
        ${input.reason},
        ${now}
      )
    `);
    return true;
  });
}

export const OFAPI_LOCAL_PARSE_REPLAY_REASONS = [
  "parser_failed",
  "contract_rejected",
  "capture_envelope_invalid",
  "invalid_json",
  "export_contract_rejected",
] as const;

export type OfapiLocalParseReplayReason =
  typeof OFAPI_LOCAL_PARSE_REPLAY_REASONS[number];

export async function replayOfapiCaptureJobParse(
  db: Database,
  input: {
    jobId: string;
    expectedState: "blocked" | "awaiting_parse";
    expectedReasonCode: OfapiLocalParseReplayReason;
    expectedJobRowVersion: number;
    actorUserId: number;
    reason: string;
    execute?: boolean;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const current = await database.execute<Record<string, unknown>>(sql`
      select *
      from ofapi_capture_jobs
      where id = ${input.jobId}::uuid
      for update
    `);
    const row = current.rows[0];
    if (!row) return null;
    const job = mapCaptureJob(row);
    if (
      job.state !== input.expectedState ||
      job.reasonCode !== input.expectedReasonCode ||
      job.rowVersion !== input.expectedJobRowVersion
    ) {
      throw new OfapiCaptureInvariantError(
        `Capture job ${input.jobId} changed before local replay`,
      );
    }
    if (
      (input.expectedReasonCode === "parser_failed" && job.state !== "awaiting_parse") ||
      (input.expectedReasonCode !== "parser_failed" && job.state !== "blocked")
    ) {
      throw new OfapiCaptureInvariantError(
        `Capture job ${input.jobId} state does not match replay reason`,
      );
    }

    const attemptResult = await database.execute<{
      id: string;
      parser_outcome: OfapiParserOutcome;
      response_observation_id: unknown;
      response_observation_received_at: string | Date;
    }>(sql`
      select id::text as id,
             parser_outcome,
             response_observation_id,
             response_observation_received_at
      from ofapi_request_attempts
      where capture_job_id = ${input.jobId}::uuid
        and state = 'response_captured'
        and response_observation_id is not null
        and response_observation_received_at is not null
      order by owner_attempt_no desc
      limit 1
      for update
    `);
    const attempt = attemptResult.rows[0];
    if (!attempt || !["failed", "contract_rejected"].includes(attempt.parser_outcome)) {
      throw new OfapiCaptureInvariantError(
        `Capture job ${input.jobId} has no failed captured response to replay`,
      );
    }
    const observationId = asNumber(
      attempt.response_observation_id,
      "response_observation_id",
    );
    const observationReceivedAt = asDate(
      attempt.response_observation_received_at,
      "response_observation_received_at",
    );
    const observation = await database.execute<{ id: unknown }>(sql`
      select id
      from observations
      where id = ${observationId}
        and received_at = ${observationReceivedAt}
        and source = 'ofapi_capture'
      limit 1
    `);
    if (observation.rows.length !== 1) {
      throw new OfapiCaptureInvariantError(
        `Capture job ${input.jobId} response observation is unavailable`,
      );
    }

    const previous = {
      state: job.state,
      reasonCode: job.reasonCode,
      rowVersion: job.rowVersion,
    };
    const next = {
      state: "awaiting_parse" as const,
      reasonCode: null,
      rowVersion: job.rowVersion + 1,
      observationId,
      observationReceivedAt,
    };
    if (input.execute === true) {
      await database.execute(sql`
        update ofapi_request_attempts
        set parser_outcome = 'pending',
            raw_count = 0,
            accepted_count = 0,
            boundary_duplicate_count = 0,
            explicitly_irrelevant_count = 0,
            rejected_count = 0,
            updated_at = ${now}
        where id = ${attempt.id}::uuid
          and state = 'response_captured'
      `);
      const updated = await database.execute<{ id: string }>(sql`
        update ofapi_capture_jobs
        set state = 'awaiting_parse',
            pending_observation_id = ${observationId},
            pending_observation_received_at = ${observationReceivedAt},
            reason_code = null,
            reason_message = null,
            lease_owner = null,
            lease_token = null,
            lease_until = null,
            source_contract_version = ${OFAPI_CAPTURE_SOURCE_CONTRACT_VERSION},
            parser_version = ${OFAPI_CAPTURE_PARSER_VERSION},
            row_version = row_version + 1,
            updated_at = ${now}
        where id = ${input.jobId}::uuid
          and state = ${input.expectedState}
          and reason_code = ${input.expectedReasonCode}
          and row_version = ${input.expectedJobRowVersion}
        returning id::text as id
      `);
      if (updated.rows.length !== 1) {
        throw new OfapiCaptureInvariantError(
          `Capture job ${input.jobId} changed during local replay`,
        );
      }
    }
    await database.execute(sql`
      insert into ofapi_capture_operator_actions (
        action, target_type, target_ref, expected_state,
        previous_state, resulting_state, dry_run,
        actor_user_id, reason, occurred_at
      ) values (
        'replay_parse',
        'job',
        ${input.jobId},
        ${`${input.expectedState}:${input.expectedReasonCode}:${input.expectedJobRowVersion}`},
        ${JSON.stringify(previous)}::jsonb,
        ${JSON.stringify({
          ...next,
          observationReceivedAt: observationReceivedAt.toISOString(),
        })}::jsonb,
        ${input.execute !== true},
        ${input.actorUserId},
        ${input.reason},
        ${now}
      )
    `);
    return {
      dryRun: input.execute !== true,
      status: input.execute === true ? "replayed" as const : "would_replay" as const,
      jobId: input.jobId,
      attemptId: attempt.id,
      previous,
      next,
    };
  });
}

export async function setOfapiCaptureControl(
  db: Database,
  input: {
    controlKey: string;
    paused: boolean;
    reason: string;
    expectedVersion: number;
    actorUserId: number;
    execute?: boolean;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const current = await database.execute<{
      paused: boolean;
      reason: string | null;
      version: unknown;
    }>(sql`
      select paused, reason, version
      from ofapi_capture_controls
      where control_key = ${input.controlKey}
      for update
    `);
    const currentRow = current.rows[0];
    const previous = currentRow
      ? {
        paused: Boolean(currentRow.paused),
        reason: currentRow.reason,
        version: asNumber(currentRow.version, "version"),
      }
      : {
        paused: false,
        reason: null,
        version: 0,
      };
    const version = previous.version;
    if (version !== input.expectedVersion) {
      throw new OfapiCaptureInvariantError(
        `Control ${input.controlKey} version ${version} does not match ${input.expectedVersion}`,
      );
    }
    const next = {
      paused: input.paused,
      reason: input.reason,
      version: version + 1,
    };
    if (input.execute === true) {
      await database.execute(sql`
        insert into ofapi_capture_controls (
          control_key, paused, reason, version, actor_user_id, updated_at
        ) values (
          ${input.controlKey},
          ${input.paused},
          ${input.reason},
          ${version + 1},
          ${input.actorUserId},
          ${now}
        )
        on conflict (control_key) do update set
          paused = excluded.paused,
          reason = excluded.reason,
          version = excluded.version,
          actor_user_id = excluded.actor_user_id,
          updated_at = excluded.updated_at
        where ofapi_capture_controls.version = ${version}
      `);
      if (!input.paused) {
        // persistent_pause is reversible operator containment, never a
        // terminal job outcome. Wake all such jobs; admission re-evaluates
        // every still-active control before any physical dispatch.
        await database.execute(sql`
          update ofapi_capture_jobs
          set state = 'ready',
              next_attempt_at = ${now},
              reason_code = null,
              reason_message = null,
              row_version = row_version + 1,
              updated_at = ${now}
          where state in ('blocked', 'retry_wait')
            and reason_code = 'persistent_pause'
        `);
      }
    }
    await database.execute(sql`
      insert into ofapi_capture_operator_actions (
        action, target_type, target_ref, expected_state,
        previous_state, resulting_state, dry_run, actor_user_id, reason, occurred_at
      ) values (
        ${input.paused ? "pause" : "resume"},
        'control',
        ${input.controlKey},
        ${String(input.expectedVersion)},
        ${JSON.stringify(previous)}::jsonb,
        ${JSON.stringify(next)}::jsonb,
        ${input.execute !== true},
        ${input.actorUserId},
        ${input.reason},
        ${now}
      )
    `);
    return { previous, next, executed: input.execute === true };
  });
}

export async function cancelBlockedOfapiExportQuoteJob(
  db: Database,
  input: {
    jobId: string;
    actorUserId: number;
    reason: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const current = await database.execute<Record<string, unknown>>(sql`
      select *
      from ofapi_capture_jobs
      where id = ${input.jobId}::uuid
      for update
    `);
    const row = current.rows[0];
    if (!row) return { cancelled: false, currentState: null };
    const job = mapCaptureJob(row);
    if (
      job.kind !== "account_export"
      || job.state !== "blocked"
      || !["owner_approval_required", "export_quote_failed"].includes(job.reasonCode ?? "")
    ) {
      return { cancelled: false, currentState: job.state };
    }
    await database.execute(sql`
      update ofapi_capture_jobs
      set state = 'cancelled',
          reason_code = 'owner_cancelled',
          reason_message = ${input.reason},
          completed_at = ${now},
          lease_owner = null,
          lease_token = null,
          lease_until = null,
          row_version = row_version + 1,
          updated_at = ${now}
      where id = ${input.jobId}::uuid
        and kind = 'account_export'
        and state = 'blocked'
        and reason_code in ('owner_approval_required', 'export_quote_failed')
    `);
    await database.execute(sql`
      insert into ofapi_capture_operator_actions (
        action, target_type, target_ref, expected_state,
        previous_state, resulting_state, dry_run, actor_user_id, reason, occurred_at
      ) values (
        'cancel_export_quote',
        'job',
        ${input.jobId},
        'blocked',
        ${JSON.stringify({ state: job.state, reasonCode: job.reasonCode })}::jsonb,
        ${JSON.stringify({ state: "cancelled" })}::jsonb,
        false,
        ${input.actorUserId},
        ${input.reason},
        ${now}
      )
    `);
    return { cancelled: true, currentState: "cancelled" as const };
  });
}

export async function getOfapiCaptureJob(db: Database, jobId: string) {
  const result = await db.execute<Record<string, unknown>>(sql`
    select * from ofapi_capture_jobs where id = ${jobId}::uuid
  `);
  return result.rows[0] ? mapCaptureJob(result.rows[0]) : null;
}

export async function getOfapiRequestAttempt(db: Database, attemptId: string) {
  const result = await db.execute<Record<string, unknown>>(sql`
    select * from ofapi_request_attempts where id = ${attemptId}::uuid
  `);
  return result.rows[0] ?? null;
}

export interface OfapiCaptureOperatorAttemptRecord {
  attemptId: string;
  captureJobId: string | null;
  pageId: number;
  operation: string;
  state: OfapiRequestAttemptState;
  creditState: "reserved" | "settled" | "released" | "indeterminate";
  reservedCredits: number;
  settledCredits: number | null;
  certaintyResolution: string | null;
  dispatchStartedAt: Date | null;
  finishedAt: Date | null;
}

function mapOperatorAttempt(row: Record<string, unknown>): OfapiCaptureOperatorAttemptRecord {
  return {
    attemptId: String(row.id),
    captureJobId: row.capture_job_id === null ? null : String(row.capture_job_id),
    pageId: asNumber(row.page_id, "page_id"),
    operation: String(row.operation),
    state: String(row.state) as OfapiRequestAttemptState,
    creditState: String(row.credit_state) as OfapiCaptureOperatorAttemptRecord["creditState"],
    reservedCredits: asNumber(row.reserved_credits, "reserved_credits"),
    settledCredits: asNullableNumber(row.settled_credits, "settled_credits"),
    certaintyResolution: row.certainty_resolution === null
      ? null
      : String(row.certainty_resolution),
    dispatchStartedAt: asNullableDate(row.dispatch_started_at, "dispatch_started_at"),
    finishedAt: asNullableDate(row.finished_at, "finished_at"),
  };
}

export async function getOfapiCaptureOperatorAttempt(db: Database, attemptId: string) {
  const result = await db.execute<Record<string, unknown>>(sql`
    select * from ofapi_request_attempts where id = ${attemptId}::uuid
  `);
  return result.rows[0] ? mapOperatorAttempt(result.rows[0]) : null;
}

export async function getOfapiCaptureOperatorStatus(
  db: Database,
  input?: { jobSampleLimit?: number; attemptSampleLimit?: number },
) {
  const jobSampleLimit = Math.max(1, Math.min(50, Math.trunc(input?.jobSampleLimit ?? 20)));
  const attemptSampleLimit = Math.max(
    1,
    Math.min(20, Math.trunc(input?.attemptSampleLimit ?? 10)),
  );
  const [controls, jobGroups, jobSamples, indeterminateSummary, attempts, storage] =
    await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select control_key, paused, reason, version, updated_at
        from ofapi_capture_controls
        order by control_key
        limit 100
      `),
      db.execute<Record<string, unknown>>(sql`
        select state, reason_code, count(*)::bigint as count,
               min(updated_at) as oldest_updated_at
        from ofapi_capture_jobs
        where state in ('ready', 'leased', 'awaiting_parse', 'retry_wait', 'blocked')
        group by state, reason_code
        order by min(updated_at), state, reason_code nulls first
        limit 100
      `),
      db.execute<Record<string, unknown>>(sql`
        select id, page_id, kind, state, reason_code, row_version, updated_at
        from ofapi_capture_jobs
        where state in ('ready', 'leased', 'awaiting_parse', 'retry_wait', 'blocked')
        order by updated_at, id
        limit ${jobSampleLimit}
      `),
      db.execute<Record<string, unknown>>(sql`
        select count(*)::bigint as count, min(finished_at) as oldest_at
        from ofapi_request_attempts
        where state = 'indeterminate' and certainty_resolved_at is null
      `),
      db.execute<Record<string, unknown>>(sql`
        select *
        from ofapi_request_attempts
        where state = 'indeterminate' and certainty_resolved_at is null
        order by finished_at, id
        limit ${attemptSampleLimit}
      `),
      db.execute<Record<string, unknown>>(sql`
        select healthy, breached, checked_at, used_bytes, free_bytes, total_bytes, error
        from ofapi_storage_health_state
        where id = 1
      `),
    ]);
  const summary = indeterminateSummary.rows[0];
  const storageRow = storage.rows[0];
  return {
    controls: controls.rows.map((row) => ({
      controlKey: String(row.control_key),
      paused: Boolean(row.paused),
      reason: row.reason === null ? null : String(row.reason),
      version: asNumber(row.version, "control.version"),
      updatedAt: asDate(row.updated_at, "control.updated_at"),
    })),
    jobGroups: jobGroups.rows.map((row) => ({
      state: String(row.state) as OfapiCaptureJobState,
      reasonCode: row.reason_code === null ? null : String(row.reason_code),
      count: asNumber(row.count, "job_group.count"),
      oldestUpdatedAt: asDate(row.oldest_updated_at, "job_group.oldest_updated_at"),
    })),
    jobSamples: jobSamples.rows.map((row) => ({
      jobId: String(row.id),
      pageId: asNumber(row.page_id, "job.page_id"),
      kind: String(row.kind) as OfapiCaptureJobKind,
      state: String(row.state) as OfapiCaptureJobState,
      reasonCode: row.reason_code === null ? null : String(row.reason_code),
      rowVersion: asNumber(row.row_version, "job.row_version"),
      updatedAt: asDate(row.updated_at, "job.updated_at"),
    })),
    indeterminate: {
      count: summary ? asNumber(summary.count, "indeterminate.count") : 0,
      oldestAt: summary
        ? asNullableDate(summary.oldest_at, "indeterminate.oldest_at")
        : null,
      samples: attempts.rows.map(mapOperatorAttempt),
    },
    storageHealth: storageRow
      ? {
        healthy: Boolean(storageRow.healthy),
        breached: Boolean(storageRow.breached),
        checkedAt: asDate(storageRow.checked_at, "storage.checked_at"),
        usedBytes: asNullableNumber(storageRow.used_bytes, "storage.used_bytes"),
        freeBytes: asNullableNumber(storageRow.free_bytes, "storage.free_bytes"),
        totalBytes: asNullableNumber(storageRow.total_bytes, "storage.total_bytes"),
        errorPresent: storageRow.error !== null,
      }
      : null,
  };
}

export async function reconcileOfapiExportCreate(
  db: Database,
  input: {
    jobId: string;
    attemptId: string;
    action: "confirm_not_created" | "adopt_created";
    vendorExportId?: string | null;
    actualCredits?: number | null;
    expectedState?: "blocked";
    expectedReasonCode?: "indeterminate";
    expectedJobRowVersion: number;
    actorUserId: number;
    reason: string;
    execute?: boolean;
    allowUnresolvedPreview?: boolean;
    recordAction?: boolean;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const jobResult = await database.execute<Record<string, unknown>>(sql`
      select * from ofapi_capture_jobs where id = ${input.jobId}::uuid for update
    `);
    const attemptResult = await database.execute<Record<string, unknown>>(sql`
      select * from ofapi_request_attempts where id = ${input.attemptId}::uuid for update
    `);
    const jobRow = jobResult.rows[0];
    const attemptRow = attemptResult.rows[0];
    if (!jobRow || !attemptRow) return { outcome: "not_found" as const };
    const job = mapCaptureJob(jobRow);
    const attempt = mapOperatorAttempt(attemptRow);
    const requiredResolution = input.action === "confirm_not_created"
      ? "confirmed_not_billed"
      : "confirmed_billed";
    const billedCredits = input.action === "confirm_not_created"
      ? 0
      : input.actualCredits === null || input.actualCredits === undefined
        ? attempt.reservedCredits
        : normalizeCredits(input.actualCredits);
    const resolutionDelta = billedCredits - attempt.reservedCredits;
    const result = jobRow.result === null ? null : asRecord(jobRow.result, "job.result");
    const marker = result?.operatorReconcile;
    const expectedVendorId = input.action === "adopt_created" ? input.vendorExportId ?? null : null;
    if (
      marker && typeof marker === "object" && !Array.isArray(marker)
      && (marker as Record<string, unknown>).action === input.action
      && (marker as Record<string, unknown>).attemptId === input.attemptId
      && ((marker as Record<string, unknown>).vendorExportId ?? null) === expectedVendorId
      && (marker as Record<string, unknown>).billedCredits === billedCredits
    ) {
      return { outcome: "already_reconciled" as const, job, attempt };
    }
    const unresolvedCertainty = attempt.certaintyResolution === null
      && attemptRow.certainty_resolved_at === null
      && attempt.creditState === "indeterminate";
    const crashWindowVersion = !unresolvedCertainty
      && attempt.certaintyResolution === requiredResolution
      && resolutionDelta !== 0
      && job.rowVersion === input.expectedJobRowVersion + 1;
    if (
      job.kind !== "account_export"
      || job.state !== (input.expectedState ?? "blocked")
      || job.reasonCode !== (input.expectedReasonCode ?? "indeterminate")
      || (job.rowVersion !== input.expectedJobRowVersion && !crashWindowVersion)
      || attempt.captureJobId !== job.id
      || attempt.pageId !== job.pageId
      || attempt.operation !== "ofapi_export_quote_create"
      || attempt.state !== "indeterminate"
      || String(attemptRow.ofapi_account_id) !== job.ofapiAccountId
      || String(attemptRow.request_semantics) !== "stateful"
    ) {
      return { outcome: "conflict" as const, job, attempt };
    }
    if (
      unresolvedCertainty
        ? !(input.execute !== true && input.allowUnresolvedPreview === true)
        : attempt.certaintyResolution !== requiredResolution
          || attemptRow.certainty_resolved_at === null
          || attempt.settledCredits !== billedCredits
          || (billedCredits === 0
            ? attempt.creditState !== "released"
            : attempt.creditState !== "settled")
    ) {
      return { outcome: "certainty_unresolved" as const, job, attempt };
    }
    if (
      input.action === "adopt_created"
      && (typeof input.vendorExportId !== "string"
        || !/^data_export_[A-Za-z0-9_-]+$/.test(input.vendorExportId))
    ) {
      throw new OfapiCaptureInvariantError("A valid vendor export id is required for adoption");
    }
    const cursor = input.action === "adopt_created"
      ? {
        phase: "quote_calculating",
        vendorExportId: input.vendorExportId!,
        vendorStatus: "operator_adopted",
        pollCount: 0,
        quoteRequestedAt: now.toISOString(),
        lastStatusAt: now.toISOString(),
        totalRows: null,
        creditCost: null,
        quotedAt: null,
        expiresAt: null,
        lastObservationId: null,
        lastObservationReceivedAt: null,
      }
      : job.cursor;
    const next = {
      state: input.action === "adopt_created" ? "retry_wait" : "blocked",
      reasonCode: input.action === "adopt_created"
        ? "export_create_reconciled"
        : "export_quote_failed",
      rowVersion: job.rowVersion + 1 + (unresolvedCertainty && resolutionDelta !== 0 ? 1 : 0),
    } as const;
    const markerValue = {
      version: 1,
      action: input.action,
      attemptId: input.attemptId,
      vendorExportId: expectedVendorId,
      billedCredits,
      reconciledAt: now.toISOString(),
    };
    if (input.execute === true) {
      const updated = await database.execute<Record<string, unknown>>(sql`
        update ofapi_capture_jobs
        set state = ${next.state},
            reason_code = ${next.reasonCode},
            reason_message = ${input.reason},
            cursor = ${cursor === null ? null : JSON.stringify(cursor)}::jsonb,
            cursor_hash = ${cursor === null ? null : hashOfapiCaptureValue(cursor)},
            result = coalesce(result, '{}'::jsonb)
              || jsonb_build_object('operatorReconcile', ${JSON.stringify(markerValue)}::jsonb),
            next_attempt_at = ${now},
            row_version = row_version + 1,
            updated_at = ${now}
        where id = ${input.jobId}::uuid
          and state = 'blocked'
          and reason_code = 'indeterminate'
          and row_version = ${job.rowVersion}
        returning *
      `);
      if (!updated.rows[0]) return { outcome: "conflict" as const, job, attempt };
      await database.execute(sql`
        insert into ofapi_capture_operator_actions (
          action, target_type, target_ref, expected_state, previous_state,
          resulting_state, dry_run, actor_user_id, reason, occurred_at
        ) values (
          ${`reconcile_export_create:${input.action}`}, 'job', ${input.jobId},
          'blocked:indeterminate',
          ${JSON.stringify({
            state: job.state,
            reasonCode: job.reasonCode,
            rowVersion: job.rowVersion,
            attemptId: input.attemptId,
            certaintyResolution: attempt.certaintyResolution,
          })}::jsonb,
          ${JSON.stringify(next)}::jsonb,
          false, ${input.actorUserId}, ${input.reason}, ${now}
        )
      `);
      return {
        outcome: "reconciled" as const,
        job: mapCaptureJob(updated.rows[0]),
        attempt,
      };
    }
    if (input.recordAction !== false) await database.execute(sql`
      insert into ofapi_capture_operator_actions (
        action, target_type, target_ref, expected_state, previous_state,
        resulting_state, dry_run, actor_user_id, reason, occurred_at
      ) values (
        ${`reconcile_export_create:${input.action}`}, 'job', ${input.jobId},
        'blocked:indeterminate',
        ${JSON.stringify({
          state: job.state,
          reasonCode: job.reasonCode,
          rowVersion: job.rowVersion,
          attemptId: input.attemptId,
          certaintyResolution: attempt.certaintyResolution,
        })}::jsonb,
        ${JSON.stringify(next)}::jsonb,
        true, ${input.actorUserId}, ${input.reason}, ${now}
      )
    `);
    return { outcome: "would_reconcile" as const, job: { ...job, ...next }, attempt };
  });
}
