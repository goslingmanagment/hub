import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { SYNC_APPLY_ERROR_PAYLOAD_UNAVAILABLE } from "./attempts.ts";
import { SYNC_RESOURCE_KEY_PATTERN, SYNC_RESOURCE_FILE_PATTERN } from "./pages.ts";
import {
  generationParam,
  jsonParam,
  nowParam,
  nullableJsonParam,
  textArrayParam,
  timestampParam,
  toBigInt,
  toDate,
  toNumber,
  toRequiredDate,
} from "./values.ts";

// Fansly Sync Engine (plan §3, §11; design §2.2, §3.4, §3.7, §4.1): the ONE
// work queue. One open row per page × resource × subject; new demand merges
// into it in the database (`upsertDemand`), raising `demand_revision` so an
// attempt admitted earlier never closes newer demand (I11).
//
// Shadow mode is gone (step 4 S4-23): every row this module writes has
// `shadow` false (`sync_work_open_uniq` still carries the column), and every
// read of a page's queue leaves out the closed rows shadow mode left behind
// (`not shadow`) until the retention prunes them.
//
// Lock order (design §3.7): `sync_pages` → erasure fence → hot tables →
// `domain_event_seq` → `sync_work` → `history_requests` → `history_request_items`.
// A transaction touching several work rows locks them in id order
// (`lockWorkRows`) and upserts new ones in (resource, subject) order
// (`upsertDemands`).

export const SYNC_WORK_KINDS = ["poll", "trigger", "goal", "repair"] as const;
export type SyncWorkKind = (typeof SYNC_WORK_KINDS)[number];

export const SYNC_WORK_CLASSES = ["urgent", "requests", "planned"] as const;
export type SyncEngineWorkClass = (typeof SYNC_WORK_CLASSES)[number];

export const SYNC_WORK_STATES = ["open", "running", "quarantined", "done", "cancelled", "superseded"] as const;
export type SyncWorkState = (typeof SYNC_WORK_STATES)[number];

/** "Почему ждёт" (plan §10): the closed dictionary. Durable reasons are stored
 *  on the row; the dynamic ones are computed by the engine's status module. */
export const SYNC_WAITING_REASONS = [
  "not_due",
  "pacer",
  "class_share",
  "page_hold",
  "resource_hold",
  "subject_breaker",
  "blocked_by_vendor",
  "quarantined",
  "paused",
  "dependency",
  "ownership_unconfirmed",
  "running",
] as const;
export type SyncWaitingReason = (typeof SYNC_WAITING_REASONS)[number];

/** Caps of the merged demand (`sync_work_merge_demand`, 0228). */
export const SYNC_WORK_DEMAND_ID_CAP = 200;
export const SYNC_WORK_DEMAND_REASON_CAP = 20;
/** Cap of a batch work's merged subject ids (`params.ids`, `mergeParamIds`):
 *  ten `/account?ids=` batches. Ids past it are dropped; their producer asks
 *  again on its next read. */
export const SYNC_WORK_PARAM_IDS_CAP = 1_000;

/** LISTEN/NOTIFY channel that wakes a page's actor; the payload is the page id. */
export const SYNC_WORK_NOTIFY_CHANNEL = "fansly_sync_work";

/** LISTEN/NOTIFY channel a settled work row announces itself on
 *  (`settleWork`), payload `<workId>:<appliedRevision>`: the wake of the
 *  "enqueue work and wait" wrapper (design §7.3). */
export const SYNC_WORK_DONE_NOTIFY_CHANNEL = "fansly_sync_work_done";

/** Candidates a class pick reads at once (design §3.4). */
export const SYNC_WORK_PICK_LIMIT = 20;

export interface SyncWorkDemand {
  messageIds: string[];
  txIds: string[];
  reasons: string[];
  overflow: boolean;
}

export interface SyncWorkRow {
  id: number;
  pageId: number;
  resource: string;
  subject: string;
  kind: SyncWorkKind;
  class: SyncEngineWorkClass;
  state: SyncWorkState;
  dueAt: Date;
  coalesceUntil: Date | null;
  deadlineAt: Date | null;
  firstDemandAt: Date;
  lastServedAt: Date | null;
  demandRevision: number;
  appliedRevision: number;
  demand: SyncWorkDemand;
  cursor: unknown;
  goal: unknown;
  proof: unknown;
  params: unknown;
  result: unknown;
  failureCount: number;
  breakerUntil: Date | null;
  blockedByVendorAt: Date | null;
  lastErrorClass: string | null;
  lastAttemptId: number | null;
  waitingReason: SyncWaitingReason | null;
  waitingUntil: Date | null;
  attemptsCount: number;
  ownerGeneration: bigint | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
}

type WorkSqlRow = {
  id: string;
  pageId: string;
  resource: string;
  subject: string;
  kind: SyncWorkKind;
  class: SyncEngineWorkClass;
  state: SyncWorkState;
  dueAt: Date | string;
  coalesceUntil: Date | string | null;
  deadlineAt: Date | string | null;
  firstDemandAt: Date | string;
  lastServedAt: Date | string | null;
  demandRevision: string;
  appliedRevision: string;
  demand: Partial<SyncWorkDemand> | null;
  cursor: unknown;
  goal: unknown;
  proof: unknown;
  params: unknown;
  result: unknown;
  failureCount: number;
  breakerUntil: Date | string | null;
  blockedByVendorAt: Date | string | null;
  lastErrorClass: string | null;
  lastAttemptId: string | null;
  waitingReason: SyncWaitingReason | null;
  waitingUntil: Date | string | null;
  attemptsCount: number;
  ownerGeneration: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  closedAt: Date | string | null;
  closeReason: string | null;
};

/** Every column but the ciphertext `secret_params`. */
const workColumns = sql`
  w.id::text as id,
  w.page_id::text as "pageId",
  w.resource,
  w.subject,
  w.kind,
  w.class,
  w.state,
  w.due_at as "dueAt",
  w.coalesce_until as "coalesceUntil",
  w.deadline_at as "deadlineAt",
  w.first_demand_at as "firstDemandAt",
  w.last_served_at as "lastServedAt",
  w.demand_revision::text as "demandRevision",
  w.applied_revision::text as "appliedRevision",
  w.demand,
  w.cursor,
  w.goal,
  w.proof,
  w.params,
  w.result,
  w.failure_count as "failureCount",
  w.breaker_until as "breakerUntil",
  w.blocked_by_vendor_at as "blockedByVendorAt",
  w.last_error_class as "lastErrorClass",
  w.last_attempt_id::text as "lastAttemptId",
  w.waiting_reason as "waitingReason",
  w.waiting_until as "waitingUntil",
  w.attempts_count as "attemptsCount",
  w.owner_generation::text as "ownerGeneration",
  w.created_at as "createdAt",
  w.updated_at as "updatedAt",
  w.closed_at as "closedAt",
  w.close_reason as "closeReason"
`;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function normalizeWorkRow(row: WorkSqlRow): SyncWorkRow {
  const demand = row.demand ?? {};
  return {
    id: Number(row.id),
    pageId: Number(row.pageId),
    resource: row.resource,
    subject: row.subject,
    kind: row.kind,
    class: row.class,
    state: row.state,
    dueAt: toRequiredDate(row.dueAt),
    coalesceUntil: toDate(row.coalesceUntil),
    deadlineAt: toDate(row.deadlineAt),
    firstDemandAt: toRequiredDate(row.firstDemandAt),
    lastServedAt: toDate(row.lastServedAt),
    demandRevision: Number(row.demandRevision),
    appliedRevision: Number(row.appliedRevision),
    demand: {
      messageIds: stringList(demand.messageIds),
      txIds: stringList(demand.txIds),
      reasons: stringList(demand.reasons),
      overflow: demand.overflow === true,
    },
    cursor: row.cursor,
    goal: row.goal,
    proof: row.proof,
    params: row.params,
    result: row.result,
    failureCount: Number(row.failureCount),
    breakerUntil: toDate(row.breakerUntil),
    blockedByVendorAt: toDate(row.blockedByVendorAt),
    lastErrorClass: row.lastErrorClass,
    lastAttemptId: toNumber(row.lastAttemptId),
    waitingReason: row.waitingReason,
    waitingUntil: toDate(row.waitingUntil),
    attemptsCount: Number(row.attemptsCount),
    ownerGeneration: toBigInt(row.ownerGeneration),
    createdAt: toRequiredDate(row.createdAt),
    updatedAt: toRequiredDate(row.updatedAt),
    closedAt: toDate(row.closedAt),
    closeReason: row.closeReason,
  };
}

function assertResourceKey(resource: string): void {
  if (!SYNC_RESOURCE_KEY_PATTERN.test(resource)) {
    throw new Error(`Not a sync resource key ('<file>.<variant>'): ${resource}`);
  }
}

function assertSubject(subject: string): void {
  if (subject.length > 200) throw new Error(`A sync work subject is at most 200 characters (${subject.length})`);
}

async function notifyWork(db: Database, pageId: number): Promise<void> {
  await db.execute(sql`select pg_notify(${SYNC_WORK_NOTIFY_CHANNEL}, ${String(pageId)})`);
}

// ── demand ────────────────────────────────────────────────────────────────────

export interface UpsertDemandInput {
  pageId: number;
  /** Registry key `<file>.<variant>`. */
  resource: string;
  /** '' for page-level work; a group id, fan id, media id … otherwise. */
  subject?: string;
  kind: SyncWorkKind;
  class: SyncEngineWorkClass;
  /** Earliest run (end of the coalescing quiet window, …); default: now. */
  dueAt?: Date | null;
  /** Hard cap of the coalescing window (first event + max). */
  coalesceUntil?: Date | null;
  /** When the result is due (urgent ordering). */
  deadlineAt?: Date | null;
  /** A further signal moves `due_at` later up to `coalesce_until` (coalescing
   *  with extension); otherwise the earlier due time wins. */
  extendOnSignal?: boolean;
  demand?: {
    messageIds?: readonly string[];
    txIds?: readonly string[];
    reasons?: readonly string[];
    overflow?: boolean;
  };
  /** Non-secret request parameters; written when the row is created only
   *  (except the id list of `mergeParamIds`). */
  params?: unknown;
  /** Subject ids a batch work serves (fan ids of `fan-profiles.lookup`): kept
   *  under `params[key]` as a set, the ids already there first, at most `cap`;
   *  merged into an open row of the key like its demand. */
  mergeParamIds?: { key: string; ids: readonly string[]; cap: number };
  /** Ciphertext (page credentials box); written when the row is created only. */
  secretParams?: string | null;
  /** Never merge into an open row of the key: create a new row, or leave the
   *  open one untouched (no revision bump, no due change) and report it with
   *  `created: false`. A work whose secret parameters are the point (a
   *  candidate identity check) must not ride on another candidate's row. */
  createOnly?: boolean;
}

export interface UpsertDemandResult {
  id: number;
  demandRevision: number;
  /** A new open row (false: merged into the open row of the key). */
  created: boolean;
}

/**
 * The only way to create or bump work (design §4.1). A new row inherits the
 * subject breaker (failures, `breaker_until`, `blocked_by_vendor_at`) of the
 * newest closed row of its key, so closing a row never resets a breaker. An
 * open row of the key takes the demand: revision + 1, merged bounded id lists
 * (overflow flag past 200), the due time per the coalescing rule, the earlier
 * deadline and coalescing cap. Wakes the page's actor (NOTIFY at commit).
 */
export async function upsertDemand(db: Database, input: UpsertDemandInput): Promise<UpsertDemandResult> {
  const subject = input.subject ?? "";
  assertResourceKey(input.resource);
  assertSubject(subject);
  const demand = {
    messageIds: [...(input.demand?.messageIds ?? [])],
    txIds: [...(input.demand?.txIds ?? [])],
    reasons: [...(input.demand?.reasons ?? [])],
    overflow: input.demand?.overflow === true,
  };
  const merge = input.mergeParamIds;
  if (merge !== undefined && (!/^[a-z][a-zA-Z0-9]*$/.test(merge.key) || !(merge.cap > 0))) {
    throw new Error(`Not a work id list (key ${merge.key}, cap ${merge.cap})`);
  }
  const mergedIds = (base: SQL): SQL => merge === undefined ? base : sql`jsonb_set(coalesce(${base}, '{}'::jsonb),
      array[${merge.key}::text],
      (select coalesce(jsonb_agg(ids.v order by ids.ord), '[]'::jsonb)
         from (select e.v, min(e.ord) as ord
                 from jsonb_array_elements_text(
                        case when jsonb_typeof(${base} -> ${merge.key}::text) = 'array'
                          then ${base} -> ${merge.key}::text else '[]'::jsonb end
                        || ${jsonParam(merge.ids)}) with ordinality as e(v, ord)
                group by e.v
                order by min(e.ord)
                limit ${merge.cap}) ids))`;
  const result = await db.execute<{ id: string; demandRevision: string; created: boolean }>(sql`
    insert into sync_work (
      page_id, shadow, resource, subject, kind, class, due_at, coalesce_until, deadline_at, demand, params,
      secret_params, failure_count, breaker_until, blocked_by_vendor_at, last_error_class
    )
    select ${input.pageId}::bigint, false, ${input.resource}::text, ${subject}::text,
           ${input.kind}::text, ${input.class}::text,
           coalesce(${timestampParam(input.dueAt)}, clock_timestamp()),
           ${timestampParam(input.coalesceUntil)},
           ${timestampParam(input.deadlineAt)},
           sync_work_merge_demand('{}'::jsonb, ${jsonParam(demand)}),
           ${mergedIds(jsonParam(input.params ?? {}))},
           ${input.secretParams ?? null}::text,
           coalesce(prev.failure_count, 0),
           prev.breaker_until,
           prev.blocked_by_vendor_at,
           prev.last_error_class
      from (select 1) as one
      left join lateral (
        select c.failure_count, c.breaker_until, c.blocked_by_vendor_at, c.last_error_class
          from sync_work c
         where c.page_id = ${input.pageId}
           and c.resource = ${input.resource}
           and c.subject = ${subject}
           and not c.shadow
           and c.closed_at is not null
         order by c.id desc
         limit 1
      ) prev on true
    on conflict (page_id, shadow, resource, subject) where state in ('open', 'running', 'quarantined')
    ${input.createOnly === true ? sql`do nothing` : sql`do update set
      demand_revision = sync_work.demand_revision + 1,
      demand = sync_work_merge_demand(sync_work.demand, excluded.demand),
      params = ${mergedIds(sql`sync_work.params`)},
      due_at = case
        when ${input.extendOnSignal === true}
          then least(sync_work.coalesce_until, greatest(sync_work.due_at, excluded.due_at))
        else least(sync_work.due_at, excluded.due_at)
      end,
      deadline_at = least(sync_work.deadline_at, excluded.deadline_at),
      coalesce_until = least(sync_work.coalesce_until, excluded.coalesce_until),
      updated_at = clock_timestamp()`}
    returning id::text as id, demand_revision::text as "demandRevision", (xmax = 0) as created
  `);
  const row = result.rows[0];
  if (!row) {
    if (input.createOnly !== true) throw new Error("sync_work upsert returned no row");
    // The open row of the key stays as it is: no demand merged, nothing to wake.
    const open = await getOpenWorkForKey(db, { pageId: input.pageId, resource: input.resource, subject });
    if (open === null) throw new Error(`sync_work ${input.resource} conflicted with an open row that is gone; retry`);
    return { id: open.id, demandRevision: open.demandRevision, created: false };
  }
  await notifyWork(db, input.pageId);
  return { id: Number(row.id), demandRevision: Number(row.demandRevision), created: row.created === true };
}

/** Sort demand signals into the lock order of new work rows: (resource, subject). */
export function sortDemandSignals<T extends { resource: string; subject?: string }>(signals: readonly T[]): T[] {
  return [...signals].sort((a, b) => {
    if (a.resource !== b.resource) return a.resource < b.resource ? -1 : 1;
    const as = a.subject ?? "";
    const bs = b.subject ?? "";
    if (as === bs) return 0;
    return as < bs ? -1 : 1;
  });
}

/** Several upserts in one transaction, in the lock order of new rows. */
export async function upsertDemands(
  db: Database,
  inputs: readonly UpsertDemandInput[],
): Promise<UpsertDemandResult[]> {
  const results: UpsertDemandResult[] = [];
  for (const input of sortDemandSignals(inputs)) {
    results.push(await upsertDemand(db, input));
  }
  return results;
}

/**
 * The registry's standing rows of a page (§4.2, §4.3): one open row per
 * enabled poll key, and per standing walk (a `goal` over a queue other writers
 * fill, `kind: 'goal'`), created with a random phase (`due_at = now + everyMs
 * × phase`, `phase` from the database's `random()` unless given). A key that
 * already has an open row keeps it. Returns how many rows were created.
 */
export async function ensurePollRows(
  db: Database,
  input: {
    pageId: number;
    polls: ReadonlyArray<{
      resource: string;
      class: SyncEngineWorkClass;
      everyMs: number;
      phase?: number;
      /** Default `poll`; a standing walk is a `goal`. */
      kind?: Extract<SyncWorkKind, "poll" | "goal">;
    }>;
  },
): Promise<number> {
  if (input.polls.length === 0) return 0;
  const polls = sortDemandSignals(input.polls).map((poll) => {
    assertResourceKey(poll.resource);
    if (!Number.isFinite(poll.everyMs) || poll.everyMs <= 0) {
      throw new Error(`Poll ${poll.resource}: everyMs must be positive, received ${poll.everyMs}`);
    }
    if (poll.phase !== undefined && !(poll.phase >= 0 && poll.phase < 1)) {
      throw new Error(`Poll ${poll.resource}: phase must be in [0, 1), received ${poll.phase}`);
    }
    const kind = poll.kind ?? "poll";
    if (kind !== "poll" && kind !== "goal") throw new Error(`Poll ${poll.resource}: a standing row is a poll or a goal`);
    return { resource: poll.resource, class: poll.class, every_ms: poll.everyMs, phase: poll.phase ?? null, kind };
  });
  const result = await db.execute(sql`
    insert into sync_work (page_id, shadow, resource, subject, kind, class, due_at)
    select ${input.pageId}::bigint, false, x.resource, '', x.kind, x.class,
           clock_timestamp() + (x.every_ms * coalesce(x.phase, random())) * interval '1 millisecond'
      from jsonb_to_recordset(${jsonParam(polls)})
        as x(resource text, class text, every_ms double precision, phase double precision, kind text)
     order by x.resource
    on conflict (page_id, shadow, resource, subject) where state in ('open', 'running', 'quarantined')
    do nothing
  `);
  const created = result.rowCount ?? 0;
  if (created > 0) await notifyWork(db, input.pageId);
  return created;
}

/**
 * "Sync now" (design §7.3): every open poll row of a page — or only those of
 * the given resource files — becomes due now. A running row,
 * a row already due and the standing walks are left alone; a poll's next due
 * time after its read is the registry's period again. Wakes the page's actor
 * when anything moved. Returns how many rows were bumped.
 */
export async function bumpPagePolls(
  db: Database,
  input: { pageId: number; files?: readonly string[] },
): Promise<number> {
  const files = input.files ?? null;
  for (const file of files ?? []) {
    if (!SYNC_RESOURCE_FILE_PATTERN.test(file)) throw new Error(`Not a sync resource file: ${file}`);
  }
  const fileFilter = files === null
    ? sql``
    : sql`and split_part(w.resource, '.', 1) = any(${textArrayParam(files)})`;
  const result = await db.execute(sql`
    update sync_work w
       set due_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where w.page_id = ${input.pageId}
       and not w.shadow
       and w.kind = 'poll'
       and w.state = 'open'
       and w.due_at > clock_timestamp()
       ${fileFilter}
  `);
  const bumped = result.rowCount ?? 0;
  if (bumped > 0) await notifyWork(db, input.pageId);
  return bumped;
}

// ── picks (design §3.4) ───────────────────────────────────────────────────────

export interface SyncWorkPickFilter {
  pageId: number;
  /** The pick instant; default: the database clock. */
  now?: Date | null;
  /** Paused keys (`sync_pages.paused_resources`). */
  excludeResources?: readonly string[];
  /** Resource files whose breaker is in force (the page's hold set). */
  excludeFiles?: readonly string[];
  /** Classes the page may not serve now (the owner's requests pause). */
  excludeClasses?: readonly SyncEngineWorkClass[];
}

/** The open item states of a history request item (0232): the fans whose
 *  chat a `requests` work still reads for. */
export const HISTORY_ITEM_OPEN_STATES = ["queued", "loading", "blocked"] as const;

/** A `requests` work is runnable only while an open history item is attached
 *  to it (I12: no history read without a request). */
const requestsWorkHasOpenItem = sql`(w.class <> 'requests' or exists (
  select 1 from history_request_items i
   where i.work_id = w.id and i.state in ('queued', 'loading', 'blocked')))`;

/** The paused, switched-off and held keys a pick leaves out — and so does
 *  the actor's idle wait (`nextOpenWorkDueAt`), or a held row would look due
 *  forever and the actor would lap without sleeping. */
function exclusionPredicate(filter: Pick<SyncWorkPickFilter, "excludeResources" | "excludeFiles" | "excludeClasses">): SQL {
  for (const file of filter.excludeFiles ?? []) {
    if (!SYNC_RESOURCE_FILE_PATTERN.test(file)) throw new Error(`Not a resource file: ${file}`);
  }
  for (const workClass of filter.excludeClasses ?? []) {
    if (!(SYNC_WORK_CLASSES as readonly string[]).includes(workClass)) throw new Error(`Not a work class: ${workClass}`);
  }
  return sql`not (w.resource = any(${textArrayParam(filter.excludeResources ?? [])}))
    and not (split_part(w.resource, '.', 1) = any(${textArrayParam(filter.excludeFiles ?? [])}))
    and not (w.class = any(${textArrayParam(filter.excludeClasses ?? [])}))`;
}

function runnablePredicate(filter: SyncWorkPickFilter, workClass: SyncEngineWorkClass): SQL {
  const now = nowParam(filter.now);
  return sql`w.page_id = ${filter.pageId}
    and not w.shadow
    and w.class = ${workClass}
    and w.state = 'open'
    and w.due_at <= ${now}
    and (w.breaker_until is null or w.breaker_until <= ${now})
    and ${exclusionPredicate(filter)}`;
}

/**
 * Urgent candidates in service order: earliest deadline (none last), then the
 * oldest demand, then id. Paused keys and held files are excluded in SQL, so a
 * paused resource can never hide runnable work behind the limit.
 */
export async function pickUrgent(
  db: Database,
  filter: SyncWorkPickFilter & { limit?: number },
): Promise<SyncWorkRow[]> {
  const result = await db.execute<WorkSqlRow>(sql`
    select ${workColumns}
      from sync_work w
     where ${runnablePredicate(filter, "urgent")}
     order by w.deadline_at nulls last, w.first_demand_at, w.id
     limit ${Math.max(1, filter.limit ?? SYNC_WORK_PICK_LIMIT)}
  `);
  return result.rows.map(normalizeWorkRow);
}

/**
 * The work a credentials page hold lets through (step-3 §3.5 item 3 (b),
 * E16; step 3b A3), due, oldest demand first: an `account.identity` check
 * that carries a candidate session or proxy (`secret_params`) — its request
 * uses the candidate, not the stored credentials that failed — and, with
 * `verify`, the `account.verify` of stored credentials the page-hold
 * core admits under the hold (their digest is not the latest refusal's; the
 * caller judged it). A 429 or network hold exempts nothing (the caller
 * checks the hold).
 */
export async function pickCredentialsCheck(
  db: Database,
  input: { pageId: number; verify: boolean },
): Promise<SyncWorkRow | null> {
  const result = await db.execute<WorkSqlRow>(sql`
    select ${workColumns}
      from sync_work w
     where w.page_id = ${input.pageId}
       and not w.shadow
       and w.state = 'open'
       and w.due_at <= clock_timestamp()
       and ((w.resource = 'account.identity' and w.secret_params is not null)
            or (${input.verify}::boolean and w.resource = 'account.verify'))
     order by w.first_demand_at, w.id
     limit 1
  `);
  const row = result.rows[0];
  return row ? normalizeWorkRow(row) : null;
}

/**
 * The due open work of the keys the actor plans before its HTTP gate (ruling
 * 9: steps that need no request wait for no page hold and no pacer slot), in
 * the order of `resources`, then by deadline (none last), oldest demand and
 * id. No class, page hold or resource hold filters it — none of those stops
 * a step without a request; a subject breaker still does, as in every pick.
 */
export async function pickBeforeGateWork(
  db: Database,
  input: { pageId: number; resources: readonly string[]; limit: number },
): Promise<SyncWorkRow[]> {
  if (input.resources.length === 0) return [];
  const resources = textArrayParam(input.resources);
  const result = await db.execute<WorkSqlRow>(sql`
    select ${workColumns}
      from sync_work w
     where w.page_id = ${input.pageId}
       and not w.shadow
       and w.state = 'open'
       and w.resource = any(${resources})
       and w.due_at <= clock_timestamp()
       and (w.breaker_until is null or w.breaker_until <= clock_timestamp())
     order by array_position(${resources}, w.resource), w.deadline_at nulls last, w.first_demand_at, w.id
     limit ${Math.max(1, input.limit)}
  `);
  return result.rows.map(normalizeWorkRow);
}

export interface PlannedPick {
  work: SyncWorkRow;
  /** `due_poll`: a poll whose due time passed (level 1); `round_robin`: the
   *  next resource key in the planned round robin (level 2). */
  level: "due_poll" | "round_robin";
}

/**
 * The planned class (plan §3, design §3.4), two levels so per-subject triggers
 * can never starve a walk: (1) a poll whose due time passed, earliest first;
 * (2) otherwise round robin BY RESOURCE KEY over the keys with due non-poll
 * work: the key served longest ago first (`sync_pages.planned_rr`; never
 * served = first), then the oldest due, then the key; within the key the
 * earliest due row. The admission stamps `planned_rr` (insertAdmission).
 */
export async function pickPlanned(
  db: Database,
  filter: SyncWorkPickFilter & { plannedRr?: Readonly<Record<string, string>> },
): Promise<PlannedPick | null> {
  const due = await db.execute<WorkSqlRow>(sql`
    select ${workColumns}
      from sync_work w
     where ${runnablePredicate(filter, "planned")}
       and w.kind = 'poll'
     order by w.due_at, w.id
     limit 1
  `);
  const poll = due.rows[0];
  if (poll) return { work: normalizeWorkRow(poll), level: "due_poll" };

  const keys = await db.execute<{ resource: string; oldestDue: Date | string }>(sql`
    select w.resource, min(w.due_at) as "oldestDue"
      from sync_work w
     where ${runnablePredicate(filter, "planned")}
       and w.kind <> 'poll'
     group by w.resource
  `);
  if (keys.rows.length === 0) return null;
  let plannedRr = filter.plannedRr;
  if (plannedRr === undefined) {
    const page = await db.execute<{ plannedRr: Record<string, string> | null }>(sql`
      select planned_rr as "plannedRr" from sync_pages where page_id = ${filter.pageId}
    `);
    plannedRr = page.rows[0]?.plannedRr ?? {};
  }
  const served = (resource: string): number => {
    const stamp = plannedRr?.[resource];
    if (stamp === undefined) return Number.NEGATIVE_INFINITY;
    const ms = Date.parse(stamp);
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  };
  const ordered = keys.rows
    .map((key) => ({ resource: key.resource, servedMs: served(key.resource), oldestDueMs: toRequiredDate(key.oldestDue).getTime() }))
    .sort((a, b) => a.servedMs - b.servedMs || a.oldestDueMs - b.oldestDueMs || (a.resource < b.resource ? -1 : 1));
  for (const key of ordered) {
    const row = await db.execute<WorkSqlRow>(sql`
      select ${workColumns}
        from sync_work w
       where ${runnablePredicate(filter, "planned")}
         and w.kind <> 'poll'
         and w.resource = ${key.resource}
       order by w.due_at, w.id
       limit 1
    `);
    const found = row.rows[0];
    if (found) return { work: normalizeWorkRow(found), level: "round_robin" };
  }
  return null;
}

export interface RequestsPick {
  work: SyncWorkRow;
  /** The request and the fan whose turn this read is (the admission stamps
   *  both and counts the read on the fan). */
  requestId: number;
  itemId: number;
}

/**
 * The requests class (plan §4.5, design §3.4): round robin between the page's
 * open requests (the one served longest ago first, never served first), then
 * between that request's fans; a fan is runnable while its chat's shared
 * `dm-messages.history` work is open, due and not broken. A blocked fan keeps
 * its turn: its chat's work is due only when the breaker lets the daily probe
 * through. Paused and held keys are excluded in SQL like every pick.
 */
export async function pickRequests(db: Database, filter: SyncWorkPickFilter): Promise<RequestsPick | null> {
  const runnable = runnablePredicate(filter, "requests");
  const request = await db.execute<{ id: string }>(sql`
    select r.id::text as id
      from history_requests r
     where r.page_id = ${filter.pageId}
       and r.state = 'open'
       and exists (
         select 1
           from history_request_items i
           join sync_work w on w.id = i.work_id
          where i.request_id = r.id
            and i.state in ('queued', 'loading', 'blocked')
            and ${runnable})
     order by r.last_served_at nulls first, r.id
     limit 1
  `);
  const requestId = request.rows[0]?.id;
  if (requestId === undefined) return null;
  const item = await db.execute<WorkSqlRow & { itemId: string }>(sql`
    select i.id::text as "itemId", ${workColumns}
      from history_request_items i
      join sync_work w on w.id = i.work_id
     where i.request_id = ${Number(requestId)}
       and i.state in ('queued', 'loading', 'blocked')
       and ${runnable}
     order by i.last_served_at nulls first, i.ordinal
     limit 1
  `);
  const row = item.rows[0];
  if (!row) return null;
  return { work: normalizeWorkRow(row), requestId: Number(requestId), itemId: Number(row.itemId) };
}

// ── admission, settlement ─────────────────────────────────────────────────────

/**
 * Admission, step 1 (tx 1 after `lockOwnedPage`): the open row becomes
 * `running`. Null when the row is no longer open (re-pick). Returns the demand
 * revision the attempt is admitted at.
 */
export async function markWorkRunning(
  db: Database,
  input: { workId: number; generation: bigint },
): Promise<{ demandRevision: number } | null> {
  const result = await db.execute<{ demandRevision: string }>(sql`
    update sync_work
       set state = 'running',
           waiting_reason = 'running',
           waiting_until = null,
           attempts_count = attempts_count + 1,
           last_served_at = clock_timestamp(),
           owner_generation = ${generationParam(input.generation)},
           updated_at = clock_timestamp()
     where id = ${input.workId}
       and state = 'open'
    returning demand_revision::text as "demandRevision"
  `);
  const row = result.rows[0];
  return row ? { demandRevision: Number(row.demandRevision) } : null;
}

export interface SettleWorkInput {
  workId: number;
  generation: bigint;
  /** The demand revision the step served: the attempt's admission revision,
   *  or for a step without HTTP the revision the plan read. */
  servedRevision: number;
  /** The step satisfied the demand up to `servedRevision` (I11). */
  satisfiesRevision: boolean;
  /** Close the work — honoured only when no newer demand arrived meanwhile. */
  close?: "done" | "cancelled";
  closeReason?: string | null;
  /** Next run while the row stays open; default: now. A newer demand that
   *  arrived during the step can only make it earlier. */
  nextDueAt?: Date | null;
  waitingReason?: SyncWaitingReason | null;
  waitingUntil?: Date | null;
  cursor?: unknown;
  proof?: unknown;
  result?: unknown;
  /** The subject breaker after this step (§9); absent: unchanged. */
  breaker?: { failureCount: number; breakerUntil: Date | null; blockedByVendorAt: Date | null };
  lastErrorClass?: string | null;
}

export interface SettleWorkResult {
  state: SyncWorkState;
  demandRevision: number;
  appliedRevision: number;
}

/**
 * Settle a work row after a step (apply, no-HTTP plan, failed attempt). The
 * row closes only when the step asked to AND no demand newer than
 * `servedRevision` arrived during the step; otherwise it stays open and runs
 * again (I11). A closing row drops its `secret_params`. The row announces
 * the settle on `fansly_sync_work_done` (delivered at commit). Null: the row
 * is not open or running any more (erased, superseded).
 */
export async function settleWork(db: Database, input: SettleWorkInput): Promise<SettleWorkResult | null> {
  const close = input.close ?? null;
  const breaker = input.breaker;
  const applied = input.satisfiesRevision ? input.servedRevision : null;
  // Evaluated in the UPDATE itself, so a demand bump that commits while this
  // statement waits for the row lock is seen (the re-checked row version).
  const closing = sql`(${close}::text is not null and w.demand_revision <= ${input.servedRevision}::bigint)`;
  const newerDemand = sql`(w.demand_revision > ${input.servedRevision}::bigint)`;
  const result = await db.execute<{ state: SyncWorkState; demandRevision: string; appliedRevision: string }>(sql`
    update sync_work w
       set applied_revision = greatest(w.applied_revision,
             least(w.demand_revision, coalesce(${applied}::bigint, w.applied_revision))),
           state = case when ${closing} then ${close}::text else 'open' end,
           closed_at = case when ${closing} then clock_timestamp() end,
           close_reason = case when ${closing} then ${input.closeReason ?? null}::text end,
           secret_params = case when ${closing} then null else w.secret_params end,
           due_at = case
             when ${closing} then w.due_at
             when ${newerDemand} then least(w.due_at, coalesce(${timestampParam(input.nextDueAt)}, w.due_at))
             else coalesce(${timestampParam(input.nextDueAt)}, clock_timestamp())
           end,
           waiting_reason = case when ${closing} then null else ${input.waitingReason ?? null}::text end,
           waiting_until = case when ${closing} then null else ${timestampParam(input.waitingUntil)} end,
           cursor = case when ${input.cursor !== undefined} then ${jsonParam(input.cursor ?? {})} else w.cursor end,
           proof = case when ${input.proof !== undefined} then ${nullableJsonParam(input.proof)} else w.proof end,
           result = case when ${input.result !== undefined} then ${nullableJsonParam(input.result)} else w.result end,
           failure_count = coalesce(${breaker === undefined ? null : breaker.failureCount}::smallint, w.failure_count),
           breaker_until = case when ${breaker !== undefined}
             then ${timestampParam(breaker?.breakerUntil)} else w.breaker_until end,
           blocked_by_vendor_at = case when ${breaker !== undefined}
             then ${timestampParam(breaker?.blockedByVendorAt)} else w.blocked_by_vendor_at end,
           last_error_class = case when ${input.lastErrorClass !== undefined}
             then ${input.lastErrorClass ?? null}::text else w.last_error_class end,
           owner_generation = ${generationParam(input.generation)},
           updated_at = clock_timestamp()
     where w.id = ${input.workId}
       and w.state in ('open', 'running')
    returning w.state, w.demand_revision::text as "demandRevision", w.applied_revision::text as "appliedRevision"
  `);
  const row = result.rows[0];
  if (!row) return null;
  await db.execute(sql`select pg_notify(${SYNC_WORK_DONE_NOTIFY_CHANNEL}, ${`${input.workId}:${row.appliedRevision}`})`);
  return {
    state: row.state,
    demandRevision: Number(row.demandRevision),
    appliedRevision: Number(row.appliedRevision),
  };
}

/** What a quarantine left on its work row (`sync_work.result.quarantine`,
 *  design step 3 §3.2 item 5): why, the refusing resource's own account of it
 *  (an `ApplyQuarantine` detail, a contract violation's field), the attempt
 *  that carried the answer, and when. The owner's levers read it. */
export interface SyncWorkQuarantineRecord {
  reason: string;
  detail: Record<string, unknown>;
  attemptId: number | null;
  at: string;
}

/** The quarantine record of a work row's `result`, or null. */
export function syncWorkQuarantineOf(result: unknown): SyncWorkQuarantineRecord | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const record = (result as Record<string, unknown>).quarantine;
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null;
  const value = record as Record<string, unknown>;
  if (typeof value.reason !== "string" || typeof value.at !== "string") return null;
  const detail = typeof value.detail === "object" && value.detail !== null && !Array.isArray(value.detail)
    ? value.detail as Record<string, unknown>
    : {};
  const attemptId = typeof value.attemptId === "number" && Number.isSafeInteger(value.attemptId) ? value.attemptId : null;
  return { reason: value.reason, detail, attemptId, at: value.at };
}

/**
 * Quarantine a work row (contract violation, deterministic apply error, a
 * body unreadable for good; §9): it takes no admission until the owner
 * requeues it; new demand still merges into it. Its `result.quarantine`
 * records why (`detail`, the attempt), in the same fenced transaction, so the
 * owner's levers (`sync work list`, the followers override) can read what the
 * apply refused; the rest of `result` is kept. False: not open/running.
 */
export async function quarantineWork(
  db: Database,
  input: {
    workId: number;
    generation: bigint;
    errorClass: string;
    detail?: Readonly<Record<string, unknown>>;
    attemptId?: number | null;
  },
): Promise<boolean> {
  const record = sql`jsonb_build_object(
    'reason', ${input.errorClass}::text,
    'detail', ${jsonParam(input.detail ?? {})},
    'attemptId', ${input.attemptId ?? null}::bigint,
    'at', to_jsonb(clock_timestamp()))`;
  const result = await db.execute(sql`
    update sync_work
       set state = 'quarantined',
           waiting_reason = 'quarantined',
           waiting_until = null,
           last_error_class = ${input.errorClass},
           result = case when jsonb_typeof(result) = 'object'
             then result || jsonb_build_object('quarantine', ${record})
             else jsonb_build_object('quarantine', ${record}) end,
           owner_generation = ${generationParam(input.generation)},
           updated_at = clock_timestamp()
     where id = ${input.workId}
       and state in ('open', 'running')
  `);
  return (result.rowCount ?? 0) > 0;
}

// ── secret parameters (design J7) ─────────────────────────────────────────────

/**
 * The ciphertext of a work's secret parameters (a signed CDN URL, a candidate
 * identity), or null. The ONLY reader of the column: the live page transport
 * of the `sync` process decrypts it right before the request it is for; no
 * other select of this module names it (`workColumns` leaves it out).
 */
export async function readSyncWorkSecretParams(db: Database, workId: number): Promise<string | null> {
  const result = await db.execute<{ secret: string | null }>(sql`
    select w.secret_params as secret from sync_work w where w.id = ${workId}
  `);
  return result.rows[0]?.secret ?? null;
}

/**
 * Replace the secret parameters of an open or running work (the next hop of a
 * CDN download: its redirect's URL, encrypted by the caller), fenced by the
 * page generation like every write of an actor. False: the row is closed.
 */
export async function setSyncWorkSecretParams(
  db: Database,
  input: { workId: number; generation: bigint; secretParams: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    update sync_work
       set secret_params = ${input.secretParams}::text,
           owner_generation = ${generationParam(input.generation)},
           updated_at = clock_timestamp()
     where id = ${input.workId}
       and state in ('open', 'running')
  `);
  return (result.rowCount ?? 0) > 0;
}

/** One row `requeueQuarantinedWork` took out of quarantine. */
export interface RequeuedSyncWork {
  id: number;
  resource: string;
  subject: string;
  /** The row's last attempt goes back to the apply from its journaled answer
   *  (no request); null: the row was opened and its next step plans anew. */
  reapplyAttemptId: number | null;
}

/**
 * The owner's requeue of quarantined work (design step 3 §3.2 item 5, plan
 * §9: "после исправления — повторное применение из журнала без HTTP").
 *
 * A row whose last attempt was quarantined with an answer in the journal is
 * re-applied from it: the attempt becomes `deferred` (due now, failures
 * reset) and the row `running` — the state of a captured answer whose apply
 * is pending, so the actor's apply drain (and a restart's recovery) applies
 * it and no pick admits a new read of the key before that. Every other
 * quarantined row (a plan quarantine, an answer whose body is gone from the
 * journal — its attempt quarantined as
 * `SYNC_APPLY_ERROR_PAYLOAD_UNAVAILABLE`) opens due now for a fresh read.
 * Both drop `result.quarantine`; a second refusal writes a new one. Only rows
 * of the page in `quarantined` are touched; NOTIFY wakes the page's actor at
 * commit.
 */
export async function requeueQuarantinedWork(
  db: Database,
  input: { pageId: number; workIds?: readonly number[]; resources?: readonly string[] },
): Promise<RequeuedSyncWork[]> {
  for (const resource of input.resources ?? []) assertResourceKey(resource);
  const ids = input.workIds === undefined ? null : [...new Set(input.workIds)].map(String);
  const idFilter = ids === null ? sql`` : sql`and w.id = any(${sql.param(ids)}::bigint[])`;
  const resourceFilter = input.resources === undefined || input.resources.length === 0
    ? sql``
    : sql`and w.resource = any(${textArrayParam(input.resources)})`;
  const result = await db.execute<{ id: string; resource: string; subject: string; reapplyAttemptId: string | null }>(sql`
    with target as (
      select w.id, w.last_attempt_id
        from sync_work w
       where w.page_id = ${input.pageId}
         and not w.shadow
         and w.state = 'quarantined'
         ${idFilter}
         ${resourceFilter}
       order by w.id
         for update of w
    ),
    reapply as (
      update sync_attempts a
         set apply_state = 'deferred',
             apply_retry_at = clock_timestamp(),
             apply_failures = 0,
             apply_error = null
        from target t
       where a.id = t.last_attempt_id
         and a.page_id = ${input.pageId}
         and not a.shadow
         and a.apply_state = 'quarantined'
         and a.observation_id is not null
         and not starts_with(coalesce(a.apply_error, ''), ${SYNC_APPLY_ERROR_PAYLOAD_UNAVAILABLE})
      returning a.id, a.work_id
    )
    update sync_work w
       set state = case when r.id is not null then 'running' else 'open' end,
           waiting_reason = case when r.id is not null then 'running' end,
           waiting_until = null,
           due_at = case when r.id is not null then w.due_at else clock_timestamp() end,
           result = case when jsonb_typeof(w.result) = 'object' then nullif(w.result - 'quarantine', '{}'::jsonb) else w.result end,
           updated_at = clock_timestamp()
      from target t
      left join reapply r on r.work_id = t.id
     where w.id = t.id
    returning w.id::text as id, w.resource, w.subject, r.id::text as "reapplyAttemptId"
  `);
  if (result.rows.length > 0) await notifyWork(db, input.pageId);
  return result.rows
    .map((row) => ({
      id: Number(row.id),
      resource: row.resource,
      subject: row.subject,
      reapplyAttemptId: row.reapplyAttemptId === null ? null : Number(row.reapplyAttemptId),
    }))
    .sort((a, b) => a.id - b.id);
}

/**
 * Close a quarantined row by an owner's decision (the followers blast-radius
 * override applied its deactivation; an owner reset of the walk) — `done` or
 * `cancelled` — or as `superseded` when what it was for is gone (the verify
 * of credentials no longer stored): with the reason, the cursor/proof the
 * decision leaves (the next row of the key reads the newest closed one's),
 * `result.quarantine` dropped. The caller holds the row (`lockWorkRows`).
 * False: not quarantined any more.
 */
export async function closeQuarantinedWork(
  db: Database,
  input: {
    workId: number;
    to: "done" | "cancelled" | "superseded";
    closeReason: string;
    cursor?: unknown;
    proof?: unknown;
  },
): Promise<boolean> {
  const done = input.to === "done";
  const result = await db.execute(sql`
    update sync_work
       set state = ${input.to}::text,
           closed_at = clock_timestamp(),
           close_reason = ${input.closeReason},
           applied_revision = case when ${done} then demand_revision else applied_revision end,
           cursor = case when ${input.cursor !== undefined} then ${jsonParam(input.cursor ?? {})} else cursor end,
           proof = case when ${input.proof !== undefined} then ${nullableJsonParam(input.proof)} else proof end,
           result = case when jsonb_typeof(result) = 'object' then nullif(result - 'quarantine', '{}'::jsonb) else result end,
           secret_params = null,
           waiting_reason = null,
           waiting_until = null,
           updated_at = clock_timestamp()
     where id = ${input.workId}
       and state = 'quarantined'
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * How many of these keys still have demand no step has served: an open (or
 * running, or quarantined) row whose `applied_revision` is behind its
 * `demand_revision`. A row that closed, or a poll whose read since applied
 * the demand, is served. Read by a repair waiting for the work it spawned.
 */
export async function countUnservedWorkForKeys(
  db: Database,
  input: { pageId: number; keys: ReadonlyArray<{ resource: string; subject: string }> },
): Promise<number> {
  if (input.keys.length === 0) return 0;
  const result = await db.execute<{ n: string }>(sql`
    select count(*)::text as n
      from sync_work w
      join unnest(${textArrayParam(input.keys.map((key) => key.resource))},
                  ${textArrayParam(input.keys.map((key) => key.subject))}) as k(resource, subject)
        on w.resource = k.resource and w.subject = k.subject
     where w.page_id = ${input.pageId}
       and not w.shadow
       and w.state in ('open', 'running', 'quarantined')
       and w.applied_revision < w.demand_revision
  `);
  return Number(result.rows[0]?.n ?? 0);
}

/** One work row by id, unlocked (the apply reads it first and settles it
 *  last, after its event appends — the lock order of §3.7). A row shadow mode
 *  left behind is no work: null. */
export async function getSyncWork(db: Database, workId: number): Promise<SyncWorkRow | null> {
  const result = await db.execute<WorkSqlRow>(sql`
    select ${workColumns} from sync_work w where w.id = ${workId} and not w.shadow
  `);
  const row = result.rows[0];
  return row ? normalizeWorkRow(row) : null;
}

/** The earliest due time of the page's open work that a pick with the same
 *  exclusions could take (the actor sleeps until then, at most a second).
 *  Null: no such open work. */
export async function nextOpenWorkDueAt(
  db: Database,
  input: Pick<SyncWorkPickFilter, "pageId" | "excludeResources" | "excludeFiles" | "excludeClasses">,
): Promise<Date | null> {
  const result = await db.execute<{ dueAt: Date | string | null }>(sql`
    select min(greatest(w.due_at, coalesce(w.breaker_until, w.due_at))) as "dueAt"
      from sync_work w
     where w.page_id = ${input.pageId}
       and not w.shadow
       and w.state = 'open'
       and ${exclusionPredicate(input)}
       and ${requestsWorkHasOpenItem}
  `);
  return toDate(result.rows[0]?.dueAt);
}

/** Which of these subjects (absent: any) have an open (or running) row of
 *  `resource` — plain read, no lock. */
export async function listOpenWorkSubjects(
  db: Database,
  input: { pageId: number; resource: string; subjects?: readonly string[] },
): Promise<Set<string>> {
  const subjects = input.subjects === undefined ? null : [...new Set(input.subjects)];
  if (subjects !== null && subjects.length === 0) return new Set();
  const result = await db.execute<{ subject: string }>(sql`
    select w.subject
      from sync_work w
     where w.page_id = ${input.pageId}
       and not w.shadow
       and w.resource = ${input.resource}
       and w.state in ('open', 'running')
       ${subjects === null ? sql`` : sql`and w.subject = any(${textArrayParam(subjects)})`}
  `);
  return new Set(result.rows.map((row) => row.subject));
}

/** The open (or running, or quarantined) row of one key, if any — plain read,
 *  no lock (`lockWorkRows` takes it before a write). */
export async function getOpenWorkForKey(
  db: Database,
  input: { pageId: number; resource: string; subject: string },
): Promise<SyncWorkRow | null> {
  const result = await db.execute<WorkSqlRow>(sql`
    select ${workColumns}
      from sync_work w
     where w.page_id = ${input.pageId}
       and not w.shadow
       and w.resource = ${input.resource}
       and w.subject = ${input.subject}
       and w.state in ('open', 'running', 'quarantined')
  `);
  const row = result.rows[0];
  return row ? normalizeWorkRow(row) : null;
}

/**
 * Drop demanded message ids a step resolved (found, or settled not found)
 * from the row's `demand.messageIds` (design §5.4 step 10). Correct whatever
 * the revision: an id a read showed is confirmed, even if its signal came
 * again meanwhile. The revision is unchanged (resolution is not demand).
 * The caller holds the row (`lockWorkRows`), after its event appends.
 */
export async function resolveWorkDemandMessageIds(
  db: Database,
  input: { workId: number; generation: bigint; messageIds: readonly string[] },
): Promise<string[] | null> {
  const ids = [...new Set(input.messageIds)];
  if (ids.length === 0) return null;
  const result = await db.execute<{ messageIds: unknown }>(sql`
    update sync_work w
       set demand = jsonb_set(coalesce(w.demand, '{}'::jsonb), '{messageIds}', coalesce((
             select jsonb_agg(e.v order by e.ord)
               from jsonb_array_elements(coalesce(w.demand->'messageIds', '[]'::jsonb)) with ordinality as e(v, ord)
              where not (e.v #>> '{}' = any(${textArrayParam(ids)}))
           ), '[]'::jsonb)),
           owner_generation = ${generationParam(input.generation)},
           updated_at = clock_timestamp()
     where w.id = ${input.workId}
       and w.state in ('open', 'running')
    returning w.demand->'messageIds' as "messageIds"
  `);
  const row = result.rows[0];
  if (!row) return null;
  return Array.isArray(row.messageIds) ? row.messageIds.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Close an OPEN row whose goal another step reached (a `dm-messages.head`
 * that confirmed past a `.catchup` target, design §5.4 step 10). Never a
 * running row (its step is in flight or its apply deferred) nor a
 * quarantined one. The caller holds the row (`lockWorkRows`). False: not open.
 */
export async function closeOpenWork(
  db: Database,
  input: { workId: number; generation: bigint; closeReason: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    update sync_work
       set state = 'done',
           closed_at = clock_timestamp(),
           close_reason = ${input.closeReason},
           applied_revision = demand_revision,
           secret_params = null,
           waiting_reason = null,
           waiting_until = null,
           owner_generation = ${generationParam(input.generation)},
           updated_at = clock_timestamp()
     where id = ${input.workId}
       and state = 'open'
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Close work rows a history request no longer needs (design §7.1.6, §7.1.7):
 * `done` when every fan riding on the row is satisfied (only an OPEN row — a
 * running one is closed by its own apply, whose hook sees the same), or
 * `cancelled` when the requests that asked for it were cancelled (open or
 * running: a read already in flight still applies, its settle finds the row
 * closed and leaves it). The caller holds the rows (`lockWorkRows`). Returns
 * the ids it closed.
 */
export async function closeWorkRows(
  db: Database,
  input: { workIds: readonly number[]; to: "done" | "cancelled"; closeReason: string },
): Promise<number[]> {
  const ids = [...new Set(input.workIds)].sort((a, b) => a - b);
  if (ids.length === 0) return [];
  const done = input.to === "done";
  const result = await db.execute<{ id: string }>(sql`
    update sync_work
       set state = ${input.to}::text,
           closed_at = clock_timestamp(),
           close_reason = ${input.closeReason},
           applied_revision = case when ${done} then demand_revision else applied_revision end,
           secret_params = null,
           waiting_reason = null,
           waiting_until = null,
           updated_at = clock_timestamp()
     where id = any(${sql.param(ids.map(String))}::bigint[])
       and (state = 'open' or (state = 'running' and not ${done}))
    returning id::text as id
  `);
  return result.rows.map((row) => Number(row.id)).sort((a, b) => a - b);
}

/** Work rows by id, unlocked (views, the history hook's walk facts). */
export async function getSyncWorkRows(db: Database, workIds: readonly number[]): Promise<Map<number, SyncWorkRow>> {
  const ids = [...new Set(workIds)];
  if (ids.length === 0) return new Map();
  const result = await db.execute<WorkSqlRow>(sql`
    select ${workColumns} from sync_work w where w.id = any(${sql.param(ids.map(String))}::bigint[])
  `);
  return new Map(result.rows.map((row) => [Number(row.id), normalizeWorkRow(row)]));
}

/** The open (or running, or quarantined) row of each subject of one key, by
 *  subject — plain read, no lock (`lockWorkRows` takes them). */
export async function openWorkIdsForSubjects(
  db: Database,
  input: { pageId: number; resource: string; subjects: readonly string[] },
): Promise<Map<string, number>> {
  const subjects = [...new Set(input.subjects)];
  if (subjects.length === 0) return new Map();
  const result = await db.execute<{ subject: string; id: string }>(sql`
    select w.subject, w.id::text as id
      from sync_work w
     where w.page_id = ${input.pageId}
       and not w.shadow
       and w.resource = ${input.resource}
       and w.state in ('open', 'running', 'quarantined')
       and w.subject = any(${textArrayParam(subjects)})
  `);
  return new Map(result.rows.map((row) => [row.subject, Number(row.id)]));
}

/** The newest row (open or closed) of each subject among a resource file's
 *  keys: the subject breaker a new demand would meet. */
export async function latestWorkForSubjects(
  db: Database,
  input: { pageId: number; resourceFile: string; subjects: readonly string[] },
): Promise<Map<string, SyncWorkRow>> {
  if (!SYNC_RESOURCE_FILE_PATTERN.test(input.resourceFile)) throw new Error(`Not a resource file: ${input.resourceFile}`);
  const subjects = [...new Set(input.subjects)];
  if (subjects.length === 0) return new Map();
  const result = await db.execute<WorkSqlRow>(sql`
    select distinct on (w.subject) ${workColumns}
      from sync_work w
     where w.page_id = ${input.pageId}
       and not w.shadow
       and w.resource like ${`${input.resourceFile}.%`}
       and w.subject = any(${textArrayParam(subjects)})
     order by w.subject, w.id desc
  `);
  return new Map(result.rows.map((row) => [row.subject, normalizeWorkRow(row)]));
}

/** Lock several work rows in id order (the lock order of §3.7). */
export async function lockWorkRows(db: Database, ids: readonly number[]): Promise<SyncWorkRow[]> {
  if (ids.length === 0) return [];
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const result = await db.execute<WorkSqlRow>(sql`
    select ${workColumns}
      from sync_work w
     where w.id = any(${sql.param(sorted.map(String))}::bigint[])
     order by w.id
       for update of w
  `);
  return result.rows.map(normalizeWorkRow);
}

// ── status ────────────────────────────────────────────────────────────────────

/** Work rows of a page for `sync status` / `sync why` (newest first). */
export async function getWorkForStatus(
  db: Database,
  input: {
    pageId: number;
    resource?: string;
    subject?: string;
    states?: readonly SyncWorkState[];
    limit?: number;
    offset?: number;
  },
): Promise<SyncWorkRow[]> {
  const filters: SQL[] = [sql`w.page_id = ${input.pageId}`, sql`not w.shadow`];
  if (input.resource !== undefined) filters.push(sql`w.resource = ${input.resource}`);
  if (input.subject !== undefined) filters.push(sql`w.subject = ${input.subject}`);
  if (input.states !== undefined) filters.push(sql`w.state = any(${textArrayParam(input.states)})`);
  const result = await db.execute<WorkSqlRow>(sql`
    select ${workColumns}
      from sync_work w
     where ${sql.join(filters, sql` and `)}
     order by w.id desc
     limit ${Math.max(1, Math.min(1_000, input.limit ?? 100))}
    offset ${Math.max(0, input.offset ?? 0)}
  `);
  return result.rows.map(normalizeWorkRow);
}

/** The newest closed row of a key (breaker carry-forward, status of closed
 *  work); with `closedAfter`, only one that closed after that instant (a
 *  caller reusing a recent result, e.g. the describer's earlier download). */
export async function latestClosedWorkForKey(
  db: Database,
  input: { pageId: number; resource: string; subject: string; closedAfter?: Date },
): Promise<SyncWorkRow | null> {
  const closedAfter = input.closedAfter === undefined ? sql`` : sql`and w.closed_at > ${timestampParam(input.closedAfter)}`;
  const result = await db.execute<WorkSqlRow>(sql`
    select ${workColumns}
      from sync_work w
     where w.page_id = ${input.pageId}
       and w.resource = ${input.resource}
       and w.subject = ${input.subject}
       and not w.shadow
       and w.closed_at is not null
       ${closedAfter}
     order by w.id desc
     limit 1
  `);
  const row = result.rows[0];
  return row ? normalizeWorkRow(row) : null;
}

/** The live work of one resource key of a page, in aggregate (the legacy
 *  status surfaces of an engine-owned page, design step 3 §3.2). */
export interface SyncWorkResourceCounts {
  pageId: number;
  resource: string;
  /** Rows open, running or quarantined (any subject). */
  active: number;
  running: number;
  quarantined: number;
  blockedByVendor: number;
  /** The largest subject-breaker failure count among those rows. */
  maxFailureCount: number;
  /** The earliest due time of an open row. */
  nextDueAt: Date | null;
}

/** Per page and key: the live rows that are open, running or quarantined,
 *  counted (one index range of `sync_work_open_uniq` per page). */
export async function countActiveLiveWorkByResource(
  db: Database,
  input: { pageIds: readonly number[] },
): Promise<SyncWorkResourceCounts[]> {
  const pageIds = [...new Set(input.pageIds)];
  if (pageIds.length === 0) return [];
  const result = await db.execute<{
    pageId: string;
    resource: string;
    active: number;
    running: number;
    quarantined: number;
    blockedByVendor: number;
    maxFailureCount: number | null;
    nextDueAt: Date | string | null;
  }>(sql`
    select w.page_id::text as "pageId",
           w.resource,
           count(*)::int as active,
           (count(*) filter (where w.state = 'running'))::int as running,
           (count(*) filter (where w.state = 'quarantined'))::int as quarantined,
           (count(*) filter (where w.blocked_by_vendor_at is not null))::int as "blockedByVendor",
           max(w.failure_count)::int as "maxFailureCount",
           min(w.due_at) filter (where w.state = 'open') as "nextDueAt"
      from sync_work w
     where w.page_id = any(${sql.param(pageIds.map(String))}::bigint[])
       and not w.shadow
       and w.state in ('open', 'running', 'quarantined')
     group by w.page_id, w.resource
     order by w.page_id, w.resource
  `);
  return result.rows.map((row) => ({
    pageId: Number(row.pageId),
    resource: row.resource,
    active: Number(row.active),
    running: Number(row.running),
    quarantined: Number(row.quarantined),
    blockedByVendor: Number(row.blockedByVendor),
    maxFailureCount: Number(row.maxFailureCount ?? 0),
    nextDueAt: toDate(row.nextDueAt),
  }));
}

/**
 * When each page-level key (subject '') of a page was last applied live: the
 * newest applied attempt of the key's three newest live rows (a poll keeps one
 * row for good, a goal a few), each read backwards along `sync_attempts_work`
 * — never a scan of the page's whole attempt journal.
 */
export async function lastLiveAppliedAtByResource(
  db: Database,
  input: { pageId: number; resources: readonly string[] },
): Promise<Map<string, Date>> {
  const resources = [...new Set(input.resources)];
  for (const resource of resources) assertResourceKey(resource);
  if (resources.length === 0) return new Map();
  const result = await db.execute<{ resource: string; appliedAt: Date | string | null }>(sql`
    select k.resource,
           (select max(recent.applied_at)
              from (select (select a.applied_at
                              from sync_attempts a
                             where a.work_id = w.id
                               and a.applied_at is not null
                             order by a.id desc
                             limit 1) as applied_at
                      from sync_work w
                     where w.page_id = ${input.pageId}
                       and w.resource = k.resource
                       and w.subject = ''
                       and not w.shadow
                     order by w.id desc
                     limit 3) recent) as "appliedAt"
      from unnest(${textArrayParam(resources)}) as k(resource)
  `);
  const applied = new Map<string, Date>();
  for (const row of result.rows) {
    const at = toDate(row.appliedAt);
    if (at !== null) applied.set(row.resource, at);
  }
  return applied;
}

/** How many of a key's newest rows `lastLiveAppliedAtOverSubjects` reads. */
export const SYNC_LAST_APPLIED_RECENT_ROWS = 20;
/** And how many of the key's active rows, the most recently attempted first. */
export const SYNC_LAST_APPLIED_ACTIVE_ROWS = 3;

/**
 * When each key that works per subject (a chat, a fan, a purchase target) was
 * last applied live on a page, over all its subjects. A key has a row per
 * subject and no index orders them by their last attempt, so two bounded sets
 * of its rows are read, each row for its newest applied attempt:
 *
 *  - its `SYNC_LAST_APPLIED_RECENT_ROWS` newest rows whatever their subject (a
 *    trigger's row closes when it is served, so the newest attempts sit on the
 *    newest rows): the key's range of `sync_work_key_recent`, ids only;
 *  - its `SYNC_LAST_APPLIED_ACTIVE_ROWS` active rows attempted last (a goal's
 *    row stays open for hours, and a request's rows take turns): the key's
 *    range of `sync_work_open_uniq`.
 *
 * Each row costs one read along `sync_attempts_work`: at most
 * `SYNC_LAST_APPLIED_RECENT_ROWS + SYNC_LAST_APPLIED_ACTIVE_ROWS` reads a key
 * however many subjects it has — never a read per subject, never a scan of the
 * page's attempt journal. A shadow row holds only shadow attempts and adds
 * nothing.
 *
 * The answer is always an applied attempt of the key, and its newest one
 * unless that sits on a closed row older than the newest read here — a
 * finished request of more chats than that, whose rows closed out of the
 * order they were filed in. The time is then earlier than the true one, never
 * later.
 */
export async function lastLiveAppliedAtOverSubjects(
  db: Database,
  input: { pageId: number; resources: readonly string[] },
): Promise<Map<string, Date>> {
  const resources = [...new Set(input.resources)];
  for (const resource of resources) assertResourceKey(resource);
  if (resources.length === 0) return new Map();
  const newestApplied = sql`
    select a.applied_at
      from sync_attempts a
     where a.work_id = w.id
       and not a.shadow
       and a.applied_at is not null
     order by a.id desc
     limit 1`;
  // `offset 0` keeps the key's rows a scan of their own index range: flattened,
  // "order by id desc limit" invites a walk of the whole table backwards along
  // its primary key, which never ends for a key the page has no rows of.
  const result = await db.execute<{ resource: string; appliedAt: Date | string | null }>(sql`
    select k.resource,
           (select max(recent.applied_at)
              from ((select a.applied_at
                       from (select s.id
                               from (select w.id
                                       from sync_work w
                                      where w.page_id = ${input.pageId}
                                        and w.resource = k.resource
                                     offset 0) s
                              order by s.id desc
                              limit ${sql.raw(String(SYNC_LAST_APPLIED_RECENT_ROWS))}) w
                      cross join lateral (${newestApplied}) a)
                    union all
                    (select a.applied_at
                       from (select w.id
                               from sync_work w
                              where w.page_id = ${input.pageId}
                                and not w.shadow
                                and w.resource = k.resource
                                and w.state in ('open', 'running', 'quarantined')
                                and w.last_attempt_id is not null
                              order by w.last_attempt_id desc
                              limit ${sql.raw(String(SYNC_LAST_APPLIED_ACTIVE_ROWS))}) w
                      cross join lateral (${newestApplied}) a)) recent) as "appliedAt"
      from unnest(${textArrayParam(resources)}) as k(resource)
  `);
  const applied = new Map<string, Date>();
  for (const row of result.rows) {
    const at = toDate(row.appliedAt);
    if (at !== null) applied.set(row.resource, at);
  }
  return applied;
}

/** The due time of the page's oldest open urgent live work that is due now
 *  (null: none) — `/health/sync`'s urgent age (`sync_work_runnable`). */
export async function oldestDueLiveUrgentWork(db: Database, input: { pageId: number }): Promise<Date | null> {
  const result = await db.execute<{ dueAt: Date | string | null }>(sql`
    select min(w.due_at) as "dueAt"
      from sync_work w
     where w.page_id = ${input.pageId}
       and not w.shadow
       and w.class = 'urgent'
       and w.state = 'open'
       and w.due_at <= clock_timestamp()
  `);
  return toDate(result.rows[0]?.dueAt);
}
