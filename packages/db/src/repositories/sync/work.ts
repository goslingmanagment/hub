import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../../client.ts";
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
// work queue. One open row per page × shadow × resource × subject; new demand
// merges into it in the database (`upsertDemand`), raising `demand_revision`
// so an attempt admitted earlier never closes newer demand (I11).
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
  shadow: boolean;
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
  shadow: boolean;
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
  w.shadow,
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
    shadow: row.shadow === true,
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
  shadow: boolean;
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
    select ${input.pageId}::bigint, ${input.shadow}::boolean, ${input.resource}::text, ${subject}::text,
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
           and c.shadow = ${input.shadow}
           and c.closed_at is not null
         order by c.id desc
         limit 1
      ) prev on true
    on conflict (page_id, shadow, resource, subject) where state in ('open', 'running', 'quarantined')
    do update set
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
      updated_at = clock_timestamp()
    returning id::text as id, demand_revision::text as "demandRevision", (xmax = 0) as created
  `);
  const row = result.rows[0];
  if (!row) throw new Error("sync_work upsert returned no row");
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
    shadow: boolean;
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
    select ${input.pageId}::bigint, ${input.shadow}::boolean, x.resource, '', x.kind, x.class,
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

// ── picks (design §3.4) ───────────────────────────────────────────────────────

export interface SyncWorkPickFilter {
  pageId: number;
  shadow: boolean;
  /** The pick instant; default: the database clock. */
  now?: Date | null;
  /** Paused keys (`sync_pages.paused_resources`). */
  excludeResources?: readonly string[];
  /** Resource files under a live resource hold (`sync_pages.resource_holds`). */
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
    and w.shadow = ${filter.shadow}
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
 * again (I11). A closing row drops its `secret_params`. Null: the row is not
 * open or running any more (erased, superseded).
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
  return {
    state: row.state,
    demandRevision: Number(row.demandRevision),
    appliedRevision: Number(row.appliedRevision),
  };
}

/**
 * Quarantine a work row (contract violation, deterministic apply error, a
 * body unreadable for good; §9): it takes no admission until the owner
 * requeues it; new demand still merges into it. False: not open/running.
 */
export async function quarantineWork(
  db: Database,
  input: { workId: number; generation: bigint; errorClass: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    update sync_work
       set state = 'quarantined',
           waiting_reason = 'quarantined',
           waiting_until = null,
           last_error_class = ${input.errorClass},
           owner_generation = ${generationParam(input.generation)},
           updated_at = clock_timestamp()
     where id = ${input.workId}
       and state in ('open', 'running')
  `);
  return (result.rowCount ?? 0) > 0;
}

/** The end of a page's shadow (step 3 takeover, §11.1 C.1): every shadow row
 *  that is still open is closed as superseded. Returns how many. */
export async function supersedeShadowWork(db: Database, input: { pageId: number }): Promise<number> {
  const result = await db.execute(sql`
    update sync_work
       set state = 'superseded',
           closed_at = clock_timestamp(),
           close_reason = 'shadow_ended',
           secret_params = null,
           waiting_reason = null,
           waiting_until = null,
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
       and shadow
       and state in ('open', 'running', 'quarantined')
  `);
  return result.rowCount ?? 0;
}

/** One work row by id, unlocked (the apply reads it first and settles it
 *  last, after its event appends — the lock order of §3.7). */
export async function getSyncWork(db: Database, workId: number): Promise<SyncWorkRow | null> {
  const result = await db.execute<WorkSqlRow>(sql`
    select ${workColumns} from sync_work w where w.id = ${workId}
  `);
  const row = result.rows[0];
  return row ? normalizeWorkRow(row) : null;
}

/** The earliest due time of the page's open work in this journal that a
 *  pick with the same exclusions could take (the actor sleeps until then, at
 *  most a second). Null: no such open work. */
export async function nextOpenWorkDueAt(
  db: Database,
  input: Pick<SyncWorkPickFilter, "pageId" | "shadow" | "excludeResources" | "excludeFiles" | "excludeClasses">,
): Promise<Date | null> {
  const result = await db.execute<{ dueAt: Date | string | null }>(sql`
    select min(greatest(w.due_at, coalesce(w.breaker_until, w.due_at))) as "dueAt"
      from sync_work w
     where w.page_id = ${input.pageId}
       and w.shadow = ${input.shadow}::boolean
       and w.state = 'open'
       and ${exclusionPredicate(input)}
       and ${requestsWorkHasOpenItem}
  `);
  return toDate(result.rows[0]?.dueAt);
}

/** Which of these subjects have an open (or running) row of `resource` in
 *  this journal — plain read, no lock. */
export async function listOpenWorkSubjects(
  db: Database,
  input: { pageId: number; shadow: boolean; resource: string; subjects: readonly string[] },
): Promise<Set<string>> {
  const subjects = [...new Set(input.subjects)];
  if (subjects.length === 0) return new Set();
  const result = await db.execute<{ subject: string }>(sql`
    select w.subject
      from sync_work w
     where w.page_id = ${input.pageId}
       and w.shadow = ${input.shadow}::boolean
       and w.resource = ${input.resource}
       and w.state in ('open', 'running')
       and w.subject = any(${textArrayParam(subjects)})
  `);
  return new Set(result.rows.map((row) => row.subject));
}

/** The open (or running, or quarantined) row of one key in this journal, if
 *  any — plain read, no lock (`lockWorkRows` takes it before a write). */
export async function getOpenWorkForKey(
  db: Database,
  input: { pageId: number; shadow: boolean; resource: string; subject: string },
): Promise<SyncWorkRow | null> {
  const result = await db.execute<WorkSqlRow>(sql`
    select ${workColumns}
      from sync_work w
     where w.page_id = ${input.pageId}
       and w.shadow = ${input.shadow}::boolean
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
  input: { pageId: number; shadow: boolean; resource: string; subjects: readonly string[] },
): Promise<Map<string, number>> {
  const subjects = [...new Set(input.subjects)];
  if (subjects.length === 0) return new Map();
  const result = await db.execute<{ subject: string; id: string }>(sql`
    select w.subject, w.id::text as id
      from sync_work w
     where w.page_id = ${input.pageId}
       and w.shadow = ${input.shadow}::boolean
       and w.resource = ${input.resource}
       and w.state in ('open', 'running', 'quarantined')
       and w.subject = any(${textArrayParam(subjects)})
  `);
  return new Map(result.rows.map((row) => [row.subject, Number(row.id)]));
}

/** The newest row (open or closed) of each subject among a resource file's
 *  keys in the live journal: the subject breaker a new demand would meet. */
export async function latestWorkForSubjects(
  db: Database,
  input: { pageId: number; shadow: boolean; resourceFile: string; subjects: readonly string[] },
): Promise<Map<string, SyncWorkRow>> {
  if (!SYNC_RESOURCE_FILE_PATTERN.test(input.resourceFile)) throw new Error(`Not a resource file: ${input.resourceFile}`);
  const subjects = [...new Set(input.subjects)];
  if (subjects.length === 0) return new Map();
  const result = await db.execute<WorkSqlRow>(sql`
    select distinct on (w.subject) ${workColumns}
      from sync_work w
     where w.page_id = ${input.pageId}
       and w.shadow = ${input.shadow}::boolean
       and w.resource like ${`${input.resourceFile}.%`}
       and w.subject = any(${textArrayParam(subjects)})
     order by w.subject, w.id desc
  `);
  return new Map(result.rows.map((row) => [row.subject, normalizeWorkRow(row)]));
}

/** Whether the page has runnable work of any of these classes now (the ETA's
 *  "no other class competes"). */
export async function hasRunnableWork(
  db: Database,
  filter: SyncWorkPickFilter & { classes: readonly SyncEngineWorkClass[] },
): Promise<boolean> {
  for (const workClass of filter.classes) {
    const result = await db.execute<{ found: boolean }>(sql`
      select exists (select 1 from sync_work w where ${runnablePredicate(filter, workClass)} and ${requestsWorkHasOpenItem})
        as found
    `);
    if (result.rows[0]?.found === true) return true;
  }
  return false;
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
    shadow?: boolean;
    resource?: string;
    subject?: string;
    states?: readonly SyncWorkState[];
    limit?: number;
    offset?: number;
  },
): Promise<SyncWorkRow[]> {
  const filters: SQL[] = [sql`w.page_id = ${input.pageId}`];
  if (input.shadow !== undefined) filters.push(sql`w.shadow = ${input.shadow}`);
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

/** The newest closed row of a key (breaker carry-forward, status of closed work). */
export async function latestClosedWorkForKey(
  db: Database,
  input: { pageId: number; shadow: boolean; resource: string; subject: string },
): Promise<SyncWorkRow | null> {
  const result = await db.execute<WorkSqlRow>(sql`
    select ${workColumns}
      from sync_work w
     where w.page_id = ${input.pageId}
       and w.resource = ${input.resource}
       and w.subject = ${input.subject}
       and w.shadow = ${input.shadow}
       and w.closed_at is not null
     order by w.id desc
     limit 1
  `);
  const row = result.rows[0];
  return row ? normalizeWorkRow(row) : null;
}
