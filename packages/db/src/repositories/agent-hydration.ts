import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import type {
  AgentHydrationCostNote,
  AgentHydrationLane,
  AgentHydrationLastError,
  AgentHydrationState,
} from "../schema.ts";
import { insertAgentReadAudit, type InsertAgentReadAuditInput } from "./agent-read-audit.ts";
import { witnessFor, type PlaneReadWitness } from "./agent-read-witness.ts";
import { legacyOwnsFanslyPageSql } from "./sync/pages.ts";

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
 * 3. **One vendor attempt per approval.** `approved -> dispatching` is a CAS
 *    like any other. The only way back is `rearmAgentHydrationRequest`, and only
 *    for a run that DETERMINATELY made no vendor request (it was refused at the
 *    page's door) — capped, journaled `rearmed`. Anything that may have spent
 *    stays one-way: a crashed run ends `failed` and a re-run needs a fresh
 *    request and a fresh owner decision (outbox discipline — a duplicated paid
 *    backfill behind the owner's back is worse than a missed one).
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
  /** Decision #202: who authorized the spend — the owner, or the versioned policy. */
  decisionSource: "owner" | "auto_policy" | null;
  decisionPolicyVersion: number | null;
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
  /** `dispatching -> approved`: the run was refused before any vendor request. */
  | "rearmed"
  | "settled"
  | "expired"
  | "failed";

export type AgentHydrationActor = "agent_key" | "owner_session" | "executor" | "sweeper" | "auto_policy";

/** Bounded structured facts only — never a caller's sentence. */
export type AgentHydrationEventDetail = Record<string, string | number | boolean | null>;

/**
 * Runs a state transition and its journal append as ONE transaction.
 *
 * The file header states the invariant; this is what enforces it. Two separate
 * statements let a failed append leave state that moved with no history, and let
 * two concurrent transitions interleave so `dispatched` is journaled before the
 * `approved` that authorized it. Both are unacceptable in a record whose whole
 * job is to say who allowed what.
 */
async function inTransaction<T>(db: Database, body: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => body(tx as unknown as Database));
}

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
    decisionSource: nullableText(row.decision_source) as "owner" | "auto_policy" | null,
    decisionPolicyVersion: nullableNum(row.decision_policy_version),
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

/**
 * `execution_lane` of a request the Fansly Sync Engine serves (step-3 design
 * §3.5 item 10: the hydration wrapper of a live page files a history request
 * and points the legacy row at it). Such a row is `dispatching` for as long as
 * its history request runs, and only the wrapper reads its state; the legacy
 * expiry, reconcile and stuck sweeps never touch it, and the legacy lane's
 * page slot, the auto-approval's one-run-per-page rule and the switch's
 * `hydration_settled` precondition never count it (the column has no CHECK,
 * 0117).
 */
export const FANSLY_SYNC_ENGINE_HYDRATION_LANE = "fansly_sync_engine";

/** The legacy sweeps' filter: rows the engine serves are not theirs. */
const LEGACY_SWEEPABLE = sql`r.execution_lane is distinct from ${FANSLY_SYNC_ENGINE_HYDRATION_LANE}`;

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

/**
 * The content hash of the DEPTH facts an approval is bound to.
 *
 * DEPTH ONLY, deliberately: how many messages we hold, where our record of the
 * thread begins, and what the coverage projection calls it. The head facts
 * (`lastMessageAt`, newest stored id) move every time the fan sends a message
 * and say nothing about how far back we reach — binding an approval to them
 * would make ordinary traffic invalidate a decision about history.
 *
 * What it DOES catch is the thing that matters: somebody already deepened this
 * thread between the proposal and the decision, so the owner would be paying for
 * work that is already done.
 */
export function hydrationCoverageFingerprint(input: {
  pageId: number;
  conversationRef: string;
  storedMessageCount: number;
  oldestStoredMessageId: string | null;
  messageCoverageStatus: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "agent-hydration-coverage-v2",
    input.pageId,
    input.conversationRef,
    input.storedMessageCount,
    input.oldestStoredMessageId,
    input.messageCoverageStatus,
  ]), "utf8").digest("hex");
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

/**
 * Resolves an approved `beforeAt` boundary to the message the walk must start
 * BEFORE.
 *
 * The target is "deepen this thread PAST this boundary", so the boundary is
 * where the walk begins, not where it stops: the oldest message we already hold
 * at or after that instant is exactly the cursor both lanes page backwards from.
 * `null` means we hold nothing at or after the boundary, and the caller falls
 * back to the deepest point we do hold.
 */
export async function resolveAgentHydrationBoundaryRef(
  db: Database,
  input: { threadId: number; beforeAt: Date },
): Promise<string | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select m.platform_message_id
    from page_dm_messages m
    where m.conversation_id = ${input.threadId}
      and m.created_at >= ${input.beforeAt}
    order by m.created_at asc, m.platform_message_id asc
    limit 1
  `);
  return nullableText(result.rows[0]?.platform_message_id);
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
  return inTransaction(db, async (tx) => {
    const inserted = await tx.execute<Record<string, unknown>>(sql`
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
      await appendEvent(tx, {
        requestId: id,
        kind: "created",
        fromState: null,
        toState: "requested",
        rowVersion: 0,
        actor: "agent_key",
        agentKeyId: input.agentKeyId,
        detail: { admissible: input.admissible, lane: input.laneSelected },
      });
      const created = await findAgentHydrationRequestById(tx, id);
      if (!created) {
        throw new Error("createAgentHydrationRequest lost the row it just inserted");
      }
      return { created: true, request: created };
    }

    const existing = await tx.execute<Record<string, unknown>>(sql`
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
  });
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
 * Looks a request up by its wire ref.
 *
 * NO WITNESS. This statement reads `agent_hydration_requests`, `pages` and
 * `agent_keys` — it does not touch `page_dm_threads`, and decision #199 is that
 * a witness proves a query actually ran. The earlier version minted a
 * thread-plane witness here on the reasoning that a request is ABOUT a thread,
 * which is precisely the "claimed a read it never performed" defect that was
 * removed from slice A.
 */
export async function findAgentHydrationRequestByRef(
  db: Database,
  requestRef: string,
): Promise<{ request: AgentHydrationRequestRecord | null; witnesses: PlaneReadWitness[] }> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${REQUEST_COLUMNS} ${REQUEST_FROM} where r.request_ref = ${requestRef}::uuid limit 1
  `);
  const row = result.rows[0];
  return { request: row ? mapRequest(row) : null, witnesses: [] };
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
  // No witness: this reads the request table, not the thread inventory.
  return { rows: result.rows.map(mapRequest), witnesses: [] };
}

export type AgentHydrationCasOutcome = "applied" | "conflict" | "coverage_stale";

export interface DecideAgentHydrationRequestInput {
  id: number;
  expectedVersion: number;
  approved: boolean;
  /** Decision #202: the decision names its author. The owner path carries the
   *  session user; the policy path carries the policy version — never a
   *  fabricated owner id. */
  decidedBy:
    | { source: "owner"; sessionUserId: number }
    | { source: "auto_policy"; policyVersion: number };
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
  /** The fingerprint the DECIDER quoted. Compared against freshly computed
   *  coverage inside this transaction, never against the stored copy. */
  coverageFingerprint: string;
  /** Written in the SAME transaction as the decision: authorizing vendor spend
   *  is exactly the act the audit trail exists to record, and a commit that
   *  outlived its audit insert would be permanently unaccounted for. */
  audit: InsertAgentReadAuditInput;
  now?: Date;
}

/**
 * The owner's decision.
 *
 * ONE TRANSACTION, four things: recompute the thread's CURRENT depth coverage
 * and compare it with what the decider quoted, CAS on version AND state AND
 * expiry, append the journal event, and write the audit row.
 *
 * The coverage half used to be done by the handler comparing the request's own
 * stored fingerprint with the value the client echoed back — a comparison of the
 * proposal with itself, which succeeded without ever reading the thread. An
 * approval could therefore commit against coverage that had changed since
 * filing, which is to say the owner could pay for work already done.
 */
export async function decideAgentHydrationRequest(
  db: Database,
  input: DecideAgentHydrationRequestInput,
): Promise<{ outcome: AgentHydrationCasOutcome; request: AgentHydrationRequestRecord | null }> {
  const now = input.now ?? new Date();
  const toState: AgentHydrationState = input.approved ? "approved" : "rejected";
  return inTransaction(db, async (tx) => {
    const target = await tx.execute<Record<string, unknown>>(sql`
      select r.page_id, r.conversation_ref
      from agent_hydration_requests r
      where r.id = ${input.id}
      for update
    `);
    const targetRow = target.rows[0];
    if (!targetRow) {
      return { outcome: "conflict" as const, request: null };
    }
    const pageId = num(targetRow.page_id);
    const conversationRef = String(targetRow.conversation_ref);
    const { thread } = await findAgentHydrationThread(tx, { pageId, conversationRef });
    const currentCoverage = thread === null
      ? null
      : hydrationCoverageFingerprint({
        pageId,
        conversationRef,
        storedMessageCount: thread.storedMessageCount,
        oldestStoredMessageId: thread.oldestStoredMessageId,
        messageCoverageStatus: thread.messageCoverageStatus,
      });
    if (currentCoverage === null || currentCoverage !== input.coverageFingerprint) {
      return {
        outcome: "coverage_stale" as const,
        request: await findAgentHydrationRequestById(tx, input.id),
      };
    }

    const decider = input.decidedBy;
    const updated = await tx.execute<Record<string, unknown>>(sql`
      update agent_hydration_requests set
        state = ${toState},
        row_version = row_version + 1,
        coverage_fingerprint = ${currentCoverage},
        decided_at = ${now},
        decided_by_user_id = ${decider.source === "owner" ? decider.sessionUserId : null},
        decision_source = ${decider.source},
        decision_policy_version = ${decider.source === "auto_policy" ? decider.policyVersion : null},
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
        -- An expired request is not decidable, swept or not. Without this a
        -- decision could revive it AND replace its TTL in one statement.
        and (expires_at is null or expires_at > ${now})
      returning id, row_version
    `);
    const row = updated.rows[0];
    if (!row) {
      return {
        outcome: "conflict" as const,
        request: await findAgentHydrationRequestById(tx, input.id),
      };
    }
    await appendEvent(tx, {
      requestId: input.id,
      kind: input.approved ? "approved" : "rejected",
      fromState: "requested",
      toState,
      rowVersion: num(row.row_version),
      actor: decider.source === "owner" ? "owner_session" : "auto_policy",
      sessionUserId: decider.source === "owner" ? decider.sessionUserId : null,
      detail: {
        decisionSource: decider.source,
        policyVersion: decider.source === "auto_policy" ? decider.policyVersion : null,
        allowMarkReadSideEffect: input.allowMarkReadSideEffect,
        maxCalls: input.maxCalls,
        maxCredits: input.maxCredits,
        maxPages: input.maxPages,
        maxItems: input.maxItems,
      },
    });
    await insertAgentReadAudit(tx, input.audit);
    return {
      outcome: "applied" as const,
      request: await findAgentHydrationRequestById(tx, input.id),
    };
  });
}

/**
 * Requests the decision-#202 auto-approve policy may even LOOK at.
 *
 * Everything the policy refuses to touch is expressed HERE, in one statement,
 * so "the policy considered it" and "the policy could never see it" stay
 * distinguishable in review:
 *   - Fansly only — the OF lane's read marks a fan's thread read, and the
 *     policy is forbidden from consenting to that side effect for the owner;
 *   - `thread_backfill_before` only — the one target whose cost is bounded;
 *   - the filing key must still be alive and still hold the capability and the
 *     page it filed against — a revoked key's parked wishes die with it;
 *   - a page with an auth-paused dm stream is skipped (its runs would burn
 *     budget against a dead session);
 *   - one live approval per page at a time (approved|dispatching from ANY
 *     decider blocks the page — this is also the per-page fairness bound);
 *   - one auto-approval per conversation per UTC day;
 *   - a thread whose per-thread breaker window is open (backoff or
 *     quarantine, `page_dm_message_sync_health`) waits it out: approved, its
 *     run would only be refused `breaker_open`, and a thread Fansly keeps
 *     answering 500 must not be walked into the same answer every day.
 *
 * The live-approval guard is a snapshot taken ONCE for the whole list, so it
 * cannot see approvals the caller makes while walking it: the caller enforces
 * "one per page" within its pass. The order serves that: every page's oldest
 * request first, then every page's second, so a page with a hundred requests
 * cannot crowd the others out of the batch, and a page whose first candidate
 * is refused still has a fallback in it.
 *
 * Sequencing: the caller is the single exclusive hydration cycle, so a plain
 * sum-then-decide over this list is race-free without reservations.
 */
export async function listAutoApprovableAgentHydrationRequests(
  db: Database,
  input: { limit: number; utcDayStart: Date; now?: Date },
): Promise<AgentHydrationRequestRecord[]> {
  const now = input.now ?? new Date();
  const result = await db.execute<Record<string, unknown>>(sql`
    select * from (
      select ${REQUEST_COLUMNS},
        row_number() over (partition by r.page_id order by r.created_at asc, r.id asc) as page_rank
      ${REQUEST_FROM}
      where r.state = 'requested'
        and r.admissible = true
        and (r.expires_at is null or r.expires_at > ${now})
        and r.target_kind = 'thread_backfill_before'
        and p.platform = 'fansly'
        -- A page the Fansly Sync Engine owns: its open rows are converted by
        -- the switch (step-3 design §3.5 phase H), never approved here.
        and ${legacyOwnsFanslyPageSql(sql.raw("r.page_id"))}
        and k.revoked_at is null
        and k.expires_at > ${now}
        and 'request:hydration' = any(k.capabilities)
        and r.page_id = any(k.page_ids)
        and not exists (
          select 1 from page_sync_states pss
          where pss.page_id = r.page_id
            and pss.stream = 'dm_messages'
            and pss.blocker_kind = 'auth'
        )
        and not exists (
          select 1 from agent_hydration_requests live
          where live.page_id = r.page_id
            and live.state in ('approved', 'dispatching')
            -- A row the engine served (a history request) is no legacy run.
            and live.execution_lane is distinct from ${FANSLY_SYNC_ENGINE_HYDRATION_LANE}
        )
        and not exists (
          select 1 from agent_hydration_requests today
          where today.page_id = r.page_id
            and today.conversation_ref = r.conversation_ref
            and today.decision_source = 'auto_policy'
            and today.decided_at >= ${input.utcDayStart}
        )
        and not exists (
          select 1 from page_dm_message_sync_health health
          where health.conversation_id = r.thread_id
            and (health.next_retry_at > ${now} or health.quarantine_until > ${now})
        )
    ) candidates
    order by page_rank asc, created_at asc, id asc
    limit ${input.limit}
  `);
  return result.rows.map(mapRequest);
}

/**
 * What today's auto-approvals count against the policy's daily budget, since
 * the UTC day start. Owner decision 2026-09-30: the budget is ACTUAL calls — a
 * settled approval returns whatever it did not use. Per approval:
 *
 *   - in flight (`approved`, `dispatching`): its full `decision_max_calls`,
 *     because the run may still spend all of it;
 *   - `expired`: nothing — an approval only returns to `approved` after a run
 *     that made no vendor request, so an expired one never spent;
 *   - settled with a known count: the `vendorCalls` its settle event journaled
 *     (HTTP attempts, retries included — it may exceed the reservation, and
 *     then that is what counts);
 *   - settled WITHOUT one — the stuck sweeper's `timeout` (a dead run's spend
 *     is unknown), any settle written before the count existed, any other
 *     state: FAIL CLOSED to the full reservation. The one exception is the
 *     earlier rule for such rows: `failed` with nothing accepted and a cause
 *     other than `timeout` was refused before any vendor request, so it is 0.
 */
export async function sumAutoApprovedCallsSince(
  db: Database,
  since: Date,
): Promise<number> {
  const result = await db.execute<{ counted: string | null }>(sql`
    select sum(
      case
        when r.state in ('approved', 'dispatching') then r.decision_max_calls
        when r.state = 'expired' then 0
        when r.state in ('completed', 'partially_completed', 'failed')
          and settle.vendor_calls is not null then settle.vendor_calls
        when r.state = 'failed' and r.last_error <> 'timeout' and r.accepted_pages = 0 then 0
        else r.decision_max_calls
      end
    )::text as counted
    from agent_hydration_requests r
    left join lateral (
      -- A request settles once (the CAS demands 'dispatching'), so this is its
      -- one settle event. Anything but a non-negative number is no count.
      select case
          when jsonb_typeof(e.detail -> 'vendorCalls') = 'number'
            and (e.detail ->> 'vendorCalls')::numeric >= 0
          then (e.detail ->> 'vendorCalls')::numeric
        end as vendor_calls
      from agent_hydration_events e
      where e.request_id = r.id
        and e.kind in ('settled', 'failed')
      order by e.seq desc
      limit 1
    ) settle on true
    where r.decision_source = 'auto_policy'
      and r.decision_approved = true
      and r.decided_at >= ${since}
  `);
  const raw = result.rows[0]?.counted;
  return raw == null ? 0 : Number(raw);
}

/**
 * Approved requests the executor may dispatch: in date, admissible, not
 * expired, on a page the legacy engine owns, oldest decision first.
 *
 * `excludeIds` is the executor's scan cursor: the rows it already walked this
 * cycle. It pages PAST the approvals that wait (busy page, parked, refused
 * before the claim) instead of being handed the same head of the queue again.
 * Ids, not a `decided_at` keyset: a JS Date cursor is milliseconds, the column
 * is microseconds, and a truncated cursor would return its own row again.
 */
export async function listDispatchableAgentHydrationRequests(
  db: Database,
  input: { limit: number; excludeIds?: readonly number[]; now?: Date },
): Promise<AgentHydrationRequestRecord[]> {
  const now = input.now ?? new Date();
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${REQUEST_COLUMNS} ${REQUEST_FROM}
    where r.state = 'approved'
      and r.admissible = true
      and (r.expires_at is null or r.expires_at > ${now})
      -- A page the Fansly Sync Engine owns: its legacy streams are fenced, and
      -- the switch converts its open rows (step-3 design §3.5 phase H).
      and ${legacyOwnsFanslyPageSql(sql.raw("r.page_id"))}
      and r.id <> all(${sql.param([...(input.excludeIds ?? [])])}::bigint[])
    order by r.decided_at asc, r.id asc
    limit ${input.limit}
  `);
  return result.rows.map(mapRequest);
}

/**
 * `approved -> dispatching`, CAS'd. This is the ONE vendor attempt: the only
 * way back to `approved` is `rearmAgentHydrationRequest`, for a run that made
 * no vendor request at all, so a crashed run is settled `failed` by the
 * sweeper and only a fresh owner decision can produce another attempt.
 *
 * The EXECUTION REFERENCE IS WRITTEN BY THIS STATEMENT, not by a follow-up
 * update. The caller mints the id first and hands it to the job it is about to
 * create, so a crash between the claim and the enqueue leaves a row that still
 * POINTS AT the work it authorized. The earlier two-step version could leave
 * `dispatching` with a null reference: reconciliation skipped such rows, the
 * sweeper eventually failed them, and the capture job they had already created
 * went on spending credits outside anybody's view.
 */
export async function claimAgentHydrationRequestForDispatch(
  db: Database,
  input: {
    id: number;
    expectedVersion: number;
    deadlineAt: Date;
    executionLane: AgentHydrationLane;
    /** Minted BEFORE the job exists and used as that job's id. */
    executionRef: string;
    now?: Date;
  },
): Promise<{ outcome: AgentHydrationCasOutcome; request: AgentHydrationRequestRecord | null }> {
  const now = input.now ?? new Date();
  return inTransaction(db, async (tx) => {
    const updated = await tx.execute<Record<string, unknown>>(sql`
      update agent_hydration_requests set
        state = 'dispatching',
        row_version = row_version + 1,
        dispatched_at = ${now},
        dispatch_deadline_at = ${input.deadlineAt},
        dispatch_count = dispatch_count + 1,
        execution_lane = ${input.executionLane},
        execution_ref = ${input.executionRef},
        updated_at = ${now}
      where id = ${input.id}
        and row_version = ${input.expectedVersion}
        and state = 'approved'
        -- An approval whose window closed buys nothing, sweeper or no sweeper.
        and (expires_at is null or expires_at > ${now})
      returning id, row_version
    `);
    const row = updated.rows[0];
    if (!row) {
      return {
        outcome: "conflict" as const,
        request: await findAgentHydrationRequestById(tx, input.id),
      };
    }
    await appendEvent(tx, {
      requestId: input.id,
      kind: "dispatched",
      fromState: "approved",
      toState: "dispatching",
      rowVersion: num(row.row_version),
      actor: "executor",
    });
    return {
      outcome: "applied" as const,
      request: await findAgentHydrationRequestById(tx, input.id),
    };
  });
}

/**
 * `dispatching -> approved`, CAS'd on the version the caller observed.
 *
 * ONLY for a run that DETERMINATELY made no vendor request: it was refused at
 * the page's door (another stream mid-chunk, the page lease held, the page's
 * targeted slot taken). Nothing was spent, so the approval's one vendor attempt
 * is still unspent and failing it would throw away an authorization for work
 * that never started. Never call this for a run that may have reached the
 * vendor — that stays one-way (file header, property 3).
 *
 * Capped by `dispatch_count`, which every claim increments and this does not
 * reset: at most `maxDispatches` claims per approval, after which the caller
 * settles the row instead. The execution columns are cleared so the row reads
 * as an ordinary not-yet-started approval; the refused job's reference is kept
 * in the journal. The expiry is left alone — an approval whose window closed
 * while it was being refused is expired by the next cycle, which is the honest
 * end for it.
 */
export async function rearmAgentHydrationRequest(
  db: Database,
  input: {
    id: number;
    expectedVersion: number;
    maxDispatches: number;
    /** The refusal, as a bounded code (e.g. a targeted-backfill outcome). */
    cause: string;
    now?: Date;
  },
): Promise<{ outcome: AgentHydrationCasOutcome; request: AgentHydrationRequestRecord | null }> {
  const now = input.now ?? new Date();
  return inTransaction(db, async (tx) => {
    // The reference the refused run carried, read under the row lock so the
    // journal records exactly what the update below clears.
    const current = await tx.execute<Record<string, unknown>>(sql`
      select execution_ref from agent_hydration_requests where id = ${input.id} for update
    `);
    const refusedExecutionRef = nullableText(current.rows[0]?.execution_ref);
    const updated = await tx.execute<Record<string, unknown>>(sql`
      update agent_hydration_requests set
        state = 'approved',
        row_version = row_version + 1,
        dispatched_at = null,
        dispatch_deadline_at = null,
        execution_lane = null,
        execution_ref = null,
        updated_at = ${now}
      where id = ${input.id}
        and row_version = ${input.expectedVersion}
        and state = 'dispatching'
        and dispatch_count < ${input.maxDispatches}
      returning id, row_version, dispatch_count
    `);
    const row = updated.rows[0];
    if (!row) {
      return {
        outcome: "conflict" as const,
        request: await findAgentHydrationRequestById(tx, input.id),
      };
    }
    await appendEvent(tx, {
      requestId: input.id,
      kind: "rearmed",
      fromState: "dispatching",
      toState: "approved",
      rowVersion: num(row.row_version),
      actor: "executor",
      detail: {
        cause: input.cause,
        dispatchCount: num(row.dispatch_count),
        executionRef: refusedExecutionRef,
      },
    });
    return {
      outcome: "applied" as const,
      request: await findAgentHydrationRequestById(tx, input.id),
    };
  });
}

/**
 * Whether the page already has a hydration run in flight. The Fansly lane runs
 * one targeted job per page at a time; its dispatcher reads this before it
 * claims, so a second approval for the page waits instead of being claimed
 * into a send the queue must refuse. A row the Fansly Sync Engine served is
 * no legacy run (its work is a history request): it never takes the slot.
 */
export async function hasDispatchingAgentHydrationRequestOnPage(
  db: Database,
  pageId: number,
): Promise<boolean> {
  const result = await db.execute<{ dispatching: boolean }>(sql`
    select exists (
      select 1 from agent_hydration_requests r
      where r.page_id = ${pageId} and r.state = 'dispatching'
        and ${LEGACY_SWEEPABLE}
    ) as dispatching
  `);
  return result.rows[0]?.dispatching === true;
}

/**
 * Corrects the execution reference when the created job COALESCED onto an
 * existing one.
 *
 * The claim already recorded the id we minted; an OnlyFans capture job that
 * lands on an occupied active slot returns the incumbent instead, and the
 * request must point at the job that will really spend. This is the only reason
 * the reference ever moves after the claim.
 */
export async function recordAgentHydrationExecution(
  db: Database,
  input: {
    id: number;
    executionLane: AgentHydrationLane;
    executionRef: string;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db.execute(sql`
    update agent_hydration_requests set
      execution_lane = ${input.executionLane},
      execution_ref = ${input.executionRef},
      updated_at = ${now}
    where id = ${input.id} and state = 'dispatching'
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
  /**
   * Journal-only: the vendor requests the run actually made (HTTP attempts,
   * retries included), when the settling party KNOWS them. The autopilot's
   * daily budget counts a settled approval by this number; omitted, it keeps
   * counting the approval's full reservation.
   */
  vendorCalls?: number;
  actor?: AgentHydrationActor;
  /** Journal-only: the executor's own code for why it settled (bounded). */
  cause?: string;
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
  return inTransaction(db, async (tx) => {
    const updated = await tx.execute<Record<string, unknown>>(sql`
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
      return {
        outcome: "conflict" as const,
        request: await findAgentHydrationRequestById(tx, input.id),
      };
    }
    await appendEvent(tx, {
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
        ...(input.vendorCalls === undefined ? {} : { vendorCalls: input.vendorCalls }),
        ...(input.cause === undefined ? {} : { cause: input.cause }),
      },
    });
    return {
      outcome: "applied" as const,
      request: await findAgentHydrationRequestById(tx, input.id),
    };
  });
}

/**
 * The stuck-`executing` sweeper's candidates: dispatched, past their deadline,
 * still not settled. A crashed worker leaves exactly this shape. Rows the
 * Fansly Sync Engine serves (FANSLY_SYNC_ENGINE_HYDRATION_LANE) are not
 * candidates: their work is a history request, not a legacy run.
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
      and ${LEGACY_SWEEPABLE}
    order by r.dispatch_deadline_at asc
    limit ${input.limit}
  `);
  return result.rows.map(mapRequest);
}

/** Everything currently in flight, deadline or not — the reconciliation input
 *  for lanes whose executor cannot report back on its own (OnlyFans). Rows the
 *  Fansly Sync Engine serves are not in flight on any legacy lane. */
export async function listDispatchingAgentHydrationRequests(
  db: Database,
  input: { limit: number },
): Promise<AgentHydrationRequestRecord[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${REQUEST_COLUMNS} ${REQUEST_FROM}
    where r.state = 'dispatching'
      and ${LEGACY_SWEEPABLE}
    order by r.dispatched_at asc
    limit ${input.limit}
  `);
  return result.rows.map(mapRequest);
}

/** Undecided or approved-but-never-dispatched requests whose expiry has passed
 *  (never a row the Fansly Sync Engine serves). */
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
      and ${LEGACY_SWEEPABLE}
    order by r.expires_at asc
    limit ${input.limit}
  `);
  return result.rows.map(mapRequest);
}

/**
 * `requested|approved -> expired`, CAS'd on the state that was observed.
 *
 * The sweeper calls it when the window closed. The executor also calls it, with
 * a `cause`, to retire an approval that can never dispatch (its thread moved
 * since the decision) before its window closes; either way nothing was spent.
 */
export async function expireAgentHydrationRequest(
  db: Database,
  input: {
    id: number;
    fromState: Extract<AgentHydrationState, "requested" | "approved">;
    actor?: Extract<AgentHydrationActor, "sweeper" | "executor">;
    /** Journal-only: why the executor retired it early (bounded code). */
    cause?: string;
    /** Journal-only: bounded facts beside the cause (the history request a
     *  switch converted the row into). */
    detail?: AgentHydrationEventDetail;
    now?: Date;
  },
): Promise<AgentHydrationCasOutcome> {
  const now = input.now ?? new Date();
  return inTransaction(db, async (tx) => {
    const updated = await tx.execute<Record<string, unknown>>(sql`
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
      return "conflict" as const;
    }
    await appendEvent(tx, {
      requestId: input.id,
      kind: "expired",
      fromState: input.fromState,
      toState: "expired",
      rowVersion: num(row.row_version),
      actor: input.actor ?? "sweeper",
      ...(input.cause === undefined && input.detail === undefined
        ? {}
        : { detail: { ...(input.detail ?? {}), ...(input.cause === undefined ? {} : { cause: input.cause }) } }),
    });
    return "applied" as const;
  });
}

/**
 * The open hydration requests of a Fansly page (`requested`, `approved`,
 * `dispatching`), oldest first, rows the engine already serves excluded: what
 * the step-3 switch converts into history requests (design step 3 §3.5 item 7,
 * phase H).
 */
export async function listOpenLegacyHydrationRequestsForPage(
  db: Database,
  pageId: number,
): Promise<AgentHydrationRequestRecord[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${REQUEST_COLUMNS} ${REQUEST_FROM}
    where r.page_id = ${pageId}
      and p.platform = 'fansly'
      and r.state in ('requested', 'approved', 'dispatching')
      and ${LEGACY_SWEEPABLE}
    order by r.created_at asc, r.id asc
  `);
  return result.rows.map(mapRequest);
}

/**
 * `requested -> dispatching` for a request the Fansly Sync Engine serves (the
 * hydration wrapper of a live page, design step 3 §3.5 item 10): the row
 * points at the history request it was filed as (`execution_lane =
 * 'fansly_sync_engine'`, `execution_ref` = its ref) and stays `dispatching`
 * while that request runs — its read mirrors the request's item, the legacy
 * sweeps and page slots never count it — and is settled to the mirrored
 * terminal state once the request is over (or `expired` by a rollback). No
 * owner decision: history requests need none (plan §4). CAS'd on the observed
 * version.
 */
export async function markAgentHydrationEngineManaged(
  db: Database,
  input: { id: number; expectedVersion: number; historyRequestRef: string; now?: Date },
): Promise<{ outcome: AgentHydrationCasOutcome; request: AgentHydrationRequestRecord | null }> {
  const now = input.now ?? new Date();
  return inTransaction(db, async (tx) => {
    const updated = await tx.execute<Record<string, unknown>>(sql`
      update agent_hydration_requests set
        state = 'dispatching',
        row_version = row_version + 1,
        dispatched_at = ${now},
        dispatch_count = dispatch_count + 1,
        execution_lane = ${FANSLY_SYNC_ENGINE_HYDRATION_LANE},
        execution_ref = ${input.historyRequestRef},
        updated_at = ${now}
      where id = ${input.id}
        and row_version = ${input.expectedVersion}
        and state = 'requested'
      returning id, row_version
    `);
    const row = updated.rows[0];
    if (!row) {
      return { outcome: "conflict" as const, request: await findAgentHydrationRequestById(tx, input.id) };
    }
    await appendEvent(tx, {
      requestId: input.id,
      kind: "dispatched",
      fromState: "requested",
      toState: "dispatching",
      rowVersion: num(row.row_version),
      actor: "executor",
      detail: { lane: FANSLY_SYNC_ENGINE_HYDRATION_LANE, ref: input.historyRequestRef },
    });
    return { outcome: "applied" as const, request: await findAgentHydrationRequestById(tx, input.id) };
  });
}

/**
 * The rows the Fansly Sync Engine serves that are still `dispatching` (the
 * wrapper's rows, step-3 design §3.5 item 10), oldest dispatch first.
 * `pageId` narrows to one page (the rollback); `endedOnly` to the rows whose
 * history request is over (`done`/`cancelled`): the worker's settle pass,
 * which must never be crowded out by requests still running.
 */
export async function listEngineManagedAgentHydrationDispatches(
  db: Database,
  input: { limit: number; pageId?: number; endedOnly?: boolean },
): Promise<AgentHydrationRequestRecord[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${REQUEST_COLUMNS} ${REQUEST_FROM}
    where r.state = 'dispatching'
      and r.execution_lane = ${FANSLY_SYNC_ENGINE_HYDRATION_LANE}
      and r.execution_ref is not null
      ${input.pageId === undefined ? sql`` : sql`and r.page_id = ${input.pageId}`}
      ${input.endedOnly === true
        ? sql`and exists (
            select 1 from history_requests h
             where h.request_ref::text = r.execution_ref
               and h.state in ('done', 'cancelled'))`
        : sql``}
    order by r.dispatched_at asc nulls first, r.id asc
    limit ${input.limit}
  `);
  return result.rows.map(mapRequest);
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
