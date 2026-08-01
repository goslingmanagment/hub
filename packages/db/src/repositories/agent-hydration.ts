import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import type {
  AgentHydrationCostNote,
  AgentHydrationLane,
  AgentHydrationLastError,
  AgentHydrationState,
} from "../schema.ts";
import { witnessFor, type PlaneReadWitness } from "./agent-read-witness.ts";

/**
 * The hydration request store (Agent Read Plane, slice C).
 *
 * THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE, none of which a handler could
 * keep on its own:
 *
 * 1. **Every transition is a CAS.** `update ... where id = $id and row_version =
 *    $expected and state = $expected_state`. Zero rows updated is a CONFLICT, not
 *    a retry and never a blind overwrite: two owners deciding the same request,
 *    or an executor racing a decision, must not both win.
 * 2. **Every transition appends an event in the SAME transaction.** The request
 *    row is the current state; `agent_hydration_events` is how it got there. A
 *    state that moved without a journal row would be a decision nobody can audit.
 * 3. **One attempt per approval.** `approved -> dispatching` is a CAS like any
 *    other, so it happens exactly once. There is no `dispatching -> approved`
 *    transition anywhere in this file: a crashed run ends `failed` and a re-run
 *    needs a fresh request and a fresh owner decision (outbox discipline — a
 *    duplicated paid backfill behind the owner's back is worse than a missed one).
 *
 * NO FREE-FORM CALLER TEXT crosses this boundary. The agent's `reason` and the
 * owner's decision reason arrive already digested as {sha256, length}, exactly
 * like `agent_read_audit.request_summary`.
 */

export interface AgentHydrationRequestRecord {
  id: number;
  requestRef: string;
  agentKeyId: number;
  agentKeyPrefix: string;
  pageId: number;
  pageLabel: string;
  platform: string;
  conversationRef: string;
  threadId: number | null;
  state: AgentHydrationState;
  targetKind: string;
  targetBeforeAt: Date | null;
  targetBeforeMessageRef: string | null;
  reasonSha256: string;
  reasonLength: number;
  requestedMaxCalls: number | null;
  idempotencyKey: string;
  requestFingerprint: string;
  coverageFingerprint: string;
  laneOrderEvaluated: AgentHydrationLane[];
  laneSelected: AgentHydrationLane | null;
  laneCostNote: AgentHydrationCostNote | null;
  admissible: boolean;
  admissibilityReason: string | null;
  rowVersion: number;
  expiresAt: Date | null;
  decidedAt: Date | null;
  decidedByUserId: number | null;
  decisionApproved: boolean | null;
  decisionAllowMarkRead: boolean | null;
  decisionMaxCalls: number | null;
  decisionMaxCredits: number | null;
  decisionMaxPages: number | null;
  decisionMaxItems: number | null;
  decisionIdempotencyKey: string | null;
  decisionFingerprint: string | null;
  dispatchedAt: Date | null;
  dispatchDeadlineAt: Date | null;
  executionLane: AgentHydrationLane | null;
  executionRef: string | null;
  dispatchCount: number;
  acceptedItems: number;
  acceptedPages: number;
  spentCredits: number;
  lastError: AgentHydrationLastError;
  settledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AgentHydrationEventKind =
  | "created"
  | "approved"
  | "rejected"
  | "dispatched"
  | "settled"
  | "expired"
  | "failed";

export type AgentHydrationActor = "agent_key" | "owner_session" | "executor" | "sweeper";

/** Bounded structured facts only — never a caller's sentence. */
export type AgentHydrationEventDetail = Record<string, string | number | boolean | null>;

function num(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`agent_hydration: expected a safe integer, got ${String(value)}`);
  }
  return parsed;
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(value as string);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapRequest(row: Record<string, unknown>): AgentHydrationRequestRecord {
  return {
    id: num(row.id),
    requestRef: String(row.request_ref),
    agentKeyId: num(row.agent_key_id),
    agentKeyPrefix: String(row.agent_key_prefix ?? ""),
    pageId: num(row.page_id),
    pageLabel: String(row.page_label ?? ""),
    platform: String(row.platform ?? ""),
    conversationRef: String(row.conversation_ref),
    threadId: nullableNum(row.thread_id),
    state: String(row.state) as AgentHydrationState,
    targetKind: String(row.target_kind),
    targetBeforeAt: nullableDate(row.target_before_at),
    targetBeforeMessageRef: nullableText(row.target_before_message_ref),
    reasonSha256: String(row.reason_sha256),
    reasonLength: num(row.reason_length),
    requestedMaxCalls: nullableNum(row.requested_max_calls),
    idempotencyKey: String(row.idempotency_key),
    requestFingerprint: String(row.request_fingerprint),
    coverageFingerprint: String(row.coverage_fingerprint),
    laneOrderEvaluated: ((row.lane_order_evaluated ?? []) as string[]).map(
      (lane) => lane as AgentHydrationLane,
    ),
    laneSelected: nullableText(row.lane_selected) as AgentHydrationLane | null,
    laneCostNote: nullableText(row.lane_cost_note) as AgentHydrationCostNote | null,
    admissible: row.admissible === true,
    admissibilityReason: nullableText(row.admissibility_reason),
    rowVersion: num(row.row_version),
    expiresAt: nullableDate(row.expires_at),
    decidedAt: nullableDate(row.decided_at),
    decidedByUserId: nullableNum(row.decided_by_user_id),
    decisionApproved: row.decision_approved === null || row.decision_approved === undefined
      ? null
      : row.decision_approved === true,
    decisionAllowMarkRead:
      row.decision_allow_mark_read === null || row.decision_allow_mark_read === undefined
        ? null
        : row.decision_allow_mark_read === true,
    decisionMaxCalls: nullableNum(row.decision_max_calls),
    decisionMaxCredits: nullableNum(row.decision_max_credits),
    decisionMaxPages: nullableNum(row.decision_max_pages),
    decisionMaxItems: nullableNum(row.decision_max_items),
    decisionIdempotencyKey: nullableText(row.decision_idempotency_key),
    decisionFingerprint: nullableText(row.decision_fingerprint),
    dispatchedAt: nullableDate(row.dispatched_at),
    dispatchDeadlineAt: nullableDate(row.dispatch_deadline_at),
    executionLane: nullableText(row.execution_lane) as AgentHydrationLane | null,
    executionRef: nullableText(row.execution_ref),
    dispatchCount: num(row.dispatch_count),
    acceptedItems: num(row.accepted_items),
    acceptedPages: num(row.accepted_pages),
    spentCredits: num(row.spent_credits),
    lastError: String(row.last_error) as AgentHydrationLastError,
    settledAt: nullableDate(row.settled_at),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

/** Every select goes through this projection so the wire shape never depends on
 *  which call site fetched the row. */
const REQUEST_COLUMNS = sql`
  r.*, p.label as page_label, p.platform::text as platform, k.key_prefix as agent_key_prefix
`;
const REQUEST_FROM = sql`
  from agent_hydration_requests r
  join pages p on p.id = r.page_id
  join agent_keys k on k.id = r.agent_key_id
`;

async function appendEvent(
  db: Database,
  input: {
    requestId: number;
    kind: AgentHydrationEventKind;
    fromState: AgentHydrationState | null;
    toState: AgentHydrationState;
    rowVersion: number;
    actor: AgentHydrationActor;
    agentKeyId?: number | null;
    sessionUserId?: number | null;
    detail?: AgentHydrationEventDetail;
  },
): Promise<void> {
  // The seq is allocated from the journal itself. Two appends for one request
  // cannot interleave in practice (every transition is CAS-serialized on the
  // request row), and if one ever did the unique (request_id, seq) refuses the
  // second rather than minting a duplicate history.
  await db.execute(sql`
    insert into agent_hydration_events (
      request_id, seq, kind, from_state, to_state, row_version,
      actor, agent_key_id, session_user_id, detail
    )
    select
      ${input.requestId},
      coalesce(max(seq), 0) + 1,
      ${input.kind},
      ${input.fromState},
      ${input.toState},
      ${input.rowVersion},
      ${input.actor},
      ${input.agentKeyId ?? null},
      ${input.sessionUserId ?? null},
      ${JSON.stringify(input.detail ?? {})}::jsonb
    from agent_hydration_events
    where request_id = ${input.requestId}
  `);
}

export interface AgentHydrationThread {
  id: number;
  storedMessageCount: number;
  oldestStoredMessageId: string | null;
  newestStoredMessageId: string | null;
  /** The vendor's head as last SEEN, which is what an OnlyFans capture job
   *  freezes its target against. Not the same as the newest STORED message. */
  lastMessageId: string | null;
  messageCoverageStatus: string;
  lastMessageAt: Date | null;
}

/**
 * The thread a hydration request is ABOUT, with the coverage columns the
 * proposal fingerprint is computed from — and the witness for the plane the
 * statement actually read. Witnesses are minted here, never by a handler: a
 * response may only claim a read that a repository performed.
 */
export async function findAgentHydrationThread(
  db: Database,
  input: { pageId: number; conversationRef: string },
): Promise<{ thread: AgentHydrationThread | null; witnesses: PlaneReadWitness[] }> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select
      t.id,
      t.stored_message_count,
      t.oldest_stored_message_id,
      t.newest_stored_message_id,
      t.last_message_id,
      t.message_coverage_status::text as message_coverage_status,
      t.last_message_at
    from page_dm_threads t
    where t.platform_account_id = ${input.pageId}
      and t.platform_conversation_id = ${input.conversationRef}
      and t.is_visible = true
    limit 1
  `);
  const row = result.rows[0];
  return {
    thread: row
      ? {
        id: num(row.id),
        storedMessageCount: num(row.stored_message_count),
        oldestStoredMessageId: nullableText(row.oldest_stored_message_id),
        newestStoredMessageId: nullableText(row.newest_stored_message_id),
        lastMessageId: nullableText(row.last_message_id),
        messageCoverageStatus: String(row.message_coverage_status),
        lastMessageAt: nullableDate(row.last_message_at),
      }
      : null,
    witnesses: [witnessFor("page_dm_threads")],
  };
}

export interface CreateAgentHydrationRequestInput {
  requestRef: string;
  agentKeyId: number;
  pageId: number;
  conversationRef: string;
  threadId: number | null;
  targetBeforeAt: Date | null;
  targetBeforeMessageRef: string | null;
  reasonSha256: string;
  reasonLength: number;
  requestedMaxCalls: number | null;
  idempotencyKey: string;
  requestFingerprint: string;
  coverageFingerprint: string;
  laneOrderEvaluated: readonly AgentHydrationLane[];
  laneSelected: AgentHydrationLane | null;
  laneCostNote: AgentHydrationCostNote | null;
  admissible: boolean;
  admissibilityReason: string | null;
  /** Undecided requests expire too, so an abandoned intent cannot be approved
   *  months later against a coverage picture nobody remembers. */
  expiresAt: Date;
}

/**
 * Idempotent create.
 *
 * `created: false` means the (key, idempotencyKey) pair already existed; the
 * CALLER compares fingerprints and decides between `coalesced` and a 409
 * `idempotency_mismatch`. Doing that comparison here would hide which of the two
 * happened from the response, and the two are different answers.
 */
export async function createAgentHydrationRequest(
  db: Database,
  input: CreateAgentHydrationRequestInput,
): Promise<{ created: boolean; request: AgentHydrationRequestRecord }> {
  const inserted = await db.execute<Record<string, unknown>>(sql`
    insert into agent_hydration_requests (
      request_ref, agent_key_id, page_id, conversation_ref, thread_id,
      state, target_kind, target_before_at, target_before_message_ref,
      reason_sha256, reason_length, requested_max_calls,
      idempotency_key, request_fingerprint, coverage_fingerprint,
      lane_order_evaluated, lane_selected, lane_cost_note,
      admissible, admissibility_reason, expires_at
    ) values (
      ${input.requestRef}::uuid,
      ${input.agentKeyId},
      ${input.pageId},
      ${input.conversationRef},
      ${input.threadId},
      'requested',
      'thread_backfill_before',
      ${input.targetBeforeAt},
      ${input.targetBeforeMessageRef},
      ${input.reasonSha256},
      ${input.reasonLength},
      ${input.requestedMaxCalls},
      ${input.idempotencyKey}::uuid,
      ${input.requestFingerprint},
      ${input.coverageFingerprint},
      ${sql.param([...input.laneOrderEvaluated])}::text[],
      ${input.laneSelected},
      ${input.laneCostNote},
      ${input.admissible},
      ${input.admissibilityReason},
      ${input.expiresAt}
    )
    on conflict (agent_key_id, idempotency_key) do nothing
    returning id
  `);

  const insertedId = inserted.rows[0]?.id;
  if (insertedId !== undefined) {
    const id = num(insertedId);
    await appendEvent(db, {
      requestId: id,
      kind: "created",
      fromState: null,
      toState: "requested",
      rowVersion: 0,
      actor: "agent_key",
      agentKeyId: input.agentKeyId,
      detail: { admissible: input.admissible, lane: input.laneSelected },
    });
    const created = await findAgentHydrationRequestById(db, id);
    if (!created) {
      throw new Error("createAgentHydrationRequest lost the row it just inserted");
    }
    return { created: true, request: created };
  }

  const existing = await db.execute<Record<string, unknown>>(sql`
    select ${REQUEST_COLUMNS} ${REQUEST_FROM}
    where r.agent_key_id = ${input.agentKeyId}
      and r.idempotency_key = ${input.idempotencyKey}::uuid
    limit 1
  `);
  const row = existing.rows[0];
  if (!row) {
    throw new Error("agent hydration idempotency conflict resolved to no row");
  }
  return { created: false, request: mapRequest(row) };
}

export async function findAgentHydrationRequestById(
  db: Database,
  id: number,
): Promise<AgentHydrationRequestRecord | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${REQUEST_COLUMNS} ${REQUEST_FROM} where r.id = ${id} limit 1
  `);
  const row = result.rows[0];
  return row ? mapRequest(row) : null;
}

/**
 * Looks a request up by its wire ref, with a witness for the plane the read
 * touched.
 *
 * `page_dm_threads` is the plane a hydration request is ABOUT, and the request
 * row carries the thread it targets — so a lookup that finds the request has, in
 * the epistemic sense, read the thread inventory for that scope.
 */
export async function findAgentHydrationRequestByRef(
  db: Database,
  requestRef: string,
): Promise<{ request: AgentHydrationRequestRecord | null; witnesses: PlaneReadWitness[] }> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${REQUEST_COLUMNS} ${REQUEST_FROM} where r.request_ref = ${requestRef}::uuid limit 1
  `);
  const row = result.rows[0];
  return {
    request: row ? mapRequest(row) : null,
    witnesses: [witnessFor("page_dm_threads")],
  };
}

export async function listAgentHydrationRequests(
  db: Database,
  input: { states?: readonly AgentHydrationState[]; limit: number },
): Promise<{ rows: AgentHydrationRequestRecord[]; witnesses: PlaneReadWitness[] }> {
  const states = input.states ?? [];
  const stateFilter = states.length > 0
    ? sql`and r.state = any(${sql.param([...states])}::text[])`
    : sql``;
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${REQUEST_COLUMNS} ${REQUEST_FROM}
    where true ${stateFilter}
    order by r.created_at desc, r.id desc
    limit ${input.limit}
  `);
  return {
    rows: result.rows.map(mapRequest),
    witnesses: [witnessFor("page_dm_threads")],
  };
}

export type AgentHydrationCasOutcome = "applied" | "conflict";

export interface DecideAgentHydrationRequestInput {
  id: number;
  expectedVersion: number;
  approved: boolean;
  sessionUserId: number;
  allowMarkReadSideEffect: boolean | null;
  maxCalls: number | null;
  maxCredits: number | null;
  maxPages: number | null;
  maxItems: number | null;
  expiresAt: Date | null;
  reasonSha256: string | null;
  reasonLength: number | null;
  idempotencyKey: string;
  decisionFingerprint: string;
  now?: Date;
}

/**
 * The owner's decision, CAS'd on `row_version` AND on `state = 'requested'`.
 *
 * Both halves matter: the version catches a stale form, and the state catches a
 * request that has already been decided or expired. The caller supplies
 * `expectedVersion` from the body, so a second approve of the same request
 * cannot pass — which is exactly the double-approve the wire calls 409 conflict.
 */
export async function decideAgentHydrationRequest(
  db: Database,
  input: DecideAgentHydrationRequestInput,
): Promise<{ outcome: AgentHydrationCasOutcome; request: AgentHydrationRequestRecord | null }> {
  const now = input.now ?? new Date();
  const toState: AgentHydrationState = input.approved ? "approved" : "rejected";
  const updated = await db.execute<Record<string, unknown>>(sql`
    update agent_hydration_requests set
      state = ${toState},
      row_version = row_version + 1,
      decided_at = ${now},
      decided_by_user_id = ${input.sessionUserId},
      decision_approved = ${input.approved},
      decision_allow_mark_read = ${input.allowMarkReadSideEffect},
      decision_max_calls = ${input.maxCalls},
      decision_max_credits = ${input.maxCredits},
      decision_max_pages = ${input.maxPages},
      decision_max_items = ${input.maxItems},
      decision_reason_sha256 = ${input.reasonSha256},
      decision_reason_length = ${input.reasonLength},
      decision_idempotency_key = ${input.idempotencyKey}::uuid,
      decision_fingerprint = ${input.decisionFingerprint},
      expires_at = coalesce(${input.expiresAt}, expires_at),
      updated_at = ${now}
    where id = ${input.id}
      and row_version = ${input.expectedVersion}
      and state = 'requested'
    returning id, row_version
  `);
  const row = updated.rows[0];
  if (!row) {
    return { outcome: "conflict", request: await findAgentHydrationRequestById(db, input.id) };
  }
  await appendEvent(db, {
    requestId: input.id,
    kind: input.approved ? "approved" : "rejected",
    fromState: "requested",
    toState,
    rowVersion: num(row.row_version),
    actor: "owner_session",
    sessionUserId: input.sessionUserId,
    detail: {
      allowMarkReadSideEffect: input.allowMarkReadSideEffect,
      maxCalls: input.maxCalls,
      maxCredits: input.maxCredits,
      maxPages: input.maxPages,
      maxItems: input.maxItems,
    },
  });
  return { outcome: "applied", request: await findAgentHydrationRequestById(db, input.id) };
}

/** Approved requests the executor may dispatch: in date, admissible, not expired. */
export async function listDispatchableAgentHydrationRequests(
  db: Database,
  input: { limit: number; now?: Date },
): Promise<AgentHydrationRequestRecord[]> {
  const now = input.now ?? new Date();
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${REQUEST_COLUMNS} ${REQUEST_FROM}
    where r.state = 'approved'
      and r.admissible = true
      and (r.expires_at is null or r.expires_at > ${now})
    order by r.decided_at asc, r.id asc
    limit ${input.limit}
  `);
  return result.rows.map(mapRequest);
}

/**
 * `approved -> dispatching`, CAS'd. This is the ONE attempt: there is no
 * transition back to `approved` anywhere, so a crashed run is settled `failed`
 * by the sweeper and only a fresh owner decision can produce another attempt.
 */
export async function claimAgentHydrationRequestForDispatch(
  db: Database,
  input: { id: number; expectedVersion: number; deadlineAt: Date; now?: Date },
): Promise<{ outcome: AgentHydrationCasOutcome; request: AgentHydrationRequestRecord | null }> {
  const now = input.now ?? new Date();
  const updated = await db.execute<Record<string, unknown>>(sql`
    update agent_hydration_requests set
      state = 'dispatching',
      row_version = row_version + 1,
      dispatched_at = ${now},
      dispatch_deadline_at = ${input.deadlineAt},
      dispatch_count = dispatch_count + 1,
      updated_at = ${now}
    where id = ${input.id}
      and row_version = ${input.expectedVersion}
      and state = 'approved'
    returning id, row_version
  `);
  const row = updated.rows[0];
  if (!row) {
    return { outcome: "conflict", request: await findAgentHydrationRequestById(db, input.id) };
  }
  await appendEvent(db, {
    requestId: input.id,
    kind: "dispatched",
    fromState: "approved",
    toState: "dispatching",
    rowVersion: num(row.row_version),
    actor: "executor",
  });
  return { outcome: "applied", request: await findAgentHydrationRequestById(db, input.id) };
}

/** Records WHAT executed the approved request, once the job exists. */
export async function recordAgentHydrationExecution(
  db: Database,
  input: {
    id: number;
    executionLane: AgentHydrationLane;
    executionRef: string | null;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db.execute(sql`
    update agent_hydration_requests set
      execution_lane = ${input.executionLane},
      execution_ref = ${input.executionRef},
      updated_at = ${now}
    where id = ${input.id}
  `);
}

export interface SettleAgentHydrationRequestInput {
  id: number;
  toState: Extract<
    AgentHydrationState,
    "completed" | "partially_completed" | "failed" | "expired"
  >;
  lastError?: AgentHydrationLastError;
  acceptedItems?: number;
  acceptedPages?: number;
  spentCredits?: number;
  actor?: AgentHydrationActor;
  now?: Date;
}

/**
 * `dispatching -> terminal`. CAS'd on the state alone (any version): the
 * settling party is whoever observed the outcome, and a settle that lost a race
 * to the stuck sweeper must be a no-op rather than a resurrection.
 */
export async function settleAgentHydrationRequest(
  db: Database,
  input: SettleAgentHydrationRequestInput,
): Promise<{ outcome: AgentHydrationCasOutcome; request: AgentHydrationRequestRecord | null }> {
  const now = input.now ?? new Date();
  const updated = await db.execute<Record<string, unknown>>(sql`
    update agent_hydration_requests set
      state = ${input.toState},
      row_version = row_version + 1,
      last_error = ${input.lastError ?? "none"},
      accepted_items = ${input.acceptedItems ?? 0},
      accepted_pages = ${input.acceptedPages ?? 0},
      spent_credits = ${input.spentCredits ?? 0},
      settled_at = ${now},
      updated_at = ${now}
    where id = ${input.id} and state = 'dispatching'
    returning id, row_version
  `);
  const row = updated.rows[0];
  if (!row) {
    return { outcome: "conflict", request: await findAgentHydrationRequestById(db, input.id) };
  }
  await appendEvent(db, {
    requestId: input.id,
    kind: input.toState === "failed" ? "failed" : "settled",
    fromState: "dispatching",
    toState: input.toState,
    rowVersion: num(row.row_version),
    actor: input.actor ?? "executor",
    detail: {
      lastError: input.lastError ?? "none",
      acceptedItems: input.acceptedItems ?? 0,
      acceptedPages: input.acceptedPages ?? 0,
    },
  });
  return { outcome: "applied", request: await findAgentHydrationRequestById(db, input.id) };
}

/**
 * The stuck-`executing` sweeper's candidates: dispatched, past their deadline,
 * still not settled. A crashed worker leaves exactly this shape.
 */
export async function listStuckAgentHydrationDispatches(
  db: Database,
  input: { limit: number; now?: Date },
): Promise<AgentHydrationRequestRecord[]> {
  const now = input.now ?? new Date();
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${REQUEST_COLUMNS} ${REQUEST_FROM}
    where r.state = 'dispatching'
      and r.dispatch_deadline_at is not null
      and r.dispatch_deadline_at <= ${now}
    order by r.dispatch_deadline_at asc
    limit ${input.limit}
  `);
  return result.rows.map(mapRequest);
}

/** Everything currently in flight, deadline or not — the reconciliation input
 *  for lanes whose executor cannot report back on its own (OnlyFans). */
export async function listDispatchingAgentHydrationRequests(
  db: Database,
  input: { limit: number },
): Promise<AgentHydrationRequestRecord[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${REQUEST_COLUMNS} ${REQUEST_FROM}
    where r.state = 'dispatching'
    order by r.dispatched_at asc
    limit ${input.limit}
  `);
  return result.rows.map(mapRequest);
}

/** Undecided or approved-but-never-dispatched requests whose expiry has passed. */
export async function listExpirableAgentHydrationRequests(
  db: Database,
  input: { limit: number; now?: Date },
): Promise<AgentHydrationRequestRecord[]> {
  const now = input.now ?? new Date();
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${REQUEST_COLUMNS} ${REQUEST_FROM}
    where r.state in ('requested', 'approved')
      and r.expires_at is not null
      and r.expires_at <= ${now}
    order by r.expires_at asc
    limit ${input.limit}
  `);
  return result.rows.map(mapRequest);
}

/** `requested|approved -> expired`, CAS'd on the state that was observed. */
export async function expireAgentHydrationRequest(
  db: Database,
  input: { id: number; fromState: Extract<AgentHydrationState, "requested" | "approved">; now?: Date },
): Promise<AgentHydrationCasOutcome> {
  const now = input.now ?? new Date();
  const updated = await db.execute<Record<string, unknown>>(sql`
    update agent_hydration_requests set
      state = 'expired',
      row_version = row_version + 1,
      settled_at = ${now},
      updated_at = ${now}
    where id = ${input.id} and state = ${input.fromState}
    returning id, row_version
  `);
  const row = updated.rows[0];
  if (!row) {
    return "conflict";
  }
  await appendEvent(db, {
    requestId: input.id,
    kind: "expired",
    fromState: input.fromState,
    toState: "expired",
    rowVersion: num(row.row_version),
    actor: "sweeper",
  });
  return "applied";
}

export interface AgentHydrationEventRecord {
  id: number;
  requestId: number;
  seq: number;
  kind: string;
  fromState: string | null;
  toState: string;
  rowVersion: number;
  actor: string;
  detail: AgentHydrationEventDetail;
  occurredAt: Date;
}

/** The append-only history of one request, oldest first. */
export async function listAgentHydrationEvents(
  db: Database,
  requestId: number,
): Promise<AgentHydrationEventRecord[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select * from agent_hydration_events where request_id = ${requestId} order by seq asc
  `);
  return result.rows.map((row) => ({
    id: num(row.id),
    requestId: num(row.request_id),
    seq: num(row.seq),
    kind: String(row.kind),
    fromState: nullableText(row.from_state),
    toState: String(row.to_state),
    rowVersion: num(row.row_version),
    actor: String(row.actor),
    detail: (row.detail ?? {}) as AgentHydrationEventDetail,
    occurredAt: new Date(row.occurred_at as string),
  }));
}
