import {
  getSyncAttempt,
  getSyncWork,
  listCrossPageCandidatePages,
  type Database,
  type SyncAttemptRow,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import {
  describeFanslyWrite,
  fanslyWritePermission,
  isFanslyWriteSendable,
  isFanslyWriteWireId,
  type FanslyWireId,
  type FanslyWireParams,
} from "@agency_hub_core/fansly";
import {
  crossSpendersListFor,
  crossSpendersListKey,
  millsFromInteger,
  type AppConfig,
  type CrossSpendersListSetting,
} from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";

import {
  CrossPageSourceRefusal,
  readCrossPageSpenders,
  resolveCrossPageSources,
} from "../../../services/cross-page-spenders.ts";
import type { OutcomeDecision } from "../../engine/errors.ts";
import { ApplyQuarantine, requestOfAttempt } from "../../engine/commit.ts";
import type {
  ApplyInput,
  ApplyResult,
  ConfirmWriteInput,
  LocalApplyInput,
  PlanContext,
  RequestPlan,
  ResourceModule,
  StepPlan,
} from "../../engine/resource.ts";
import { parseFanListItemsAnswer, parseFanListsAnswer } from "../lib/fan-lists-rules.ts";
import {
  diffFanSetList,
  FAN_SET_LIST_AWAIT_MS,
  FAN_SET_LIST_CYCLE_MAX_MS,
  FAN_SET_LIST_MAX_PAGES,
  FAN_SET_LIST_RECHECK_MS,
  FAN_SET_LIST_TRANSPORT_RECHECK_MS,
  nextFanSetListSyncAt,
  readListCreateAnswer,
  readListWriteAnswer,
  resolveHubList,
  writeAttemptVerdict,
  type FanSetListWrite,
} from "../lib/fan-set-list-rules.ts";
import { writeOutcomeDecision } from "../publish/commands.ts";

// `fan-set-lists.sync` (2026-10-28): a Fansly user list of the page that Hub
// keeps equal to a set of fans: the page's cross-page spenders
// (services/cross-page-spenders.ts: the fans of its audience who paid the
// model's other pages and never paid it), for «Excluded lists» of the page's
// mass message. Per page by the owner's `crossSpendersLists` (default: no
// page). A standing walk of the page: its plan looks at the setting every
// 10 minutes and syncs about every 6 hours, at once after the setting changed.
// One request a step, the position in the row's cursor:
//
// 1. `/lists/account`: the page's lists. Hub's list is the one it stored (made
//    or found under this label) while it is there, else the one list labelled
//    exactly so; none → it is created (2); two or more and none stored → the
//    sync is cut (`label_ambiguous`): Hub never takes a list it cannot tell
//    for its own.
// 2. `POST /lists` with the label, when there is none.
// 3. `/lists/itemsnew` from the head, 100 members a page, to an empty page.
// 4. The set, read now (every page a candidate, never an agent's grant), and
//    the diff (lib/fan-set-list-rules.ts): the set's fans not in the list
//    added, the list's members not in the set removed (a fan someone added
//    by hand too: the list is Hub's). A fan the page's account lookup no
//    longer returns is neither. The guard: a set that came back empty while
//    the list is not, or more than half the list to remove, withholds every
//    removal (the adds still go) and the receipt says why.
// 5. The writes, adds first, 50 accounts each.
//
// Each write gets one attempt. The plan reads the row's last attempt before
// it plans a write: one under way waits for its answer; one that failed,
// never left or may have left cuts the sync there, and the next sync (an
// hour later) re-reads the list and recomputes the diff (convergence, never
// a retry). An indeterminate create is found by its label next time. A
// changed setting or a sync older than 2 hours cuts it too. A write leaves
// only through the page's browser holding Hub's `create` permission (the
// page's publishing on), confirmed fresh at its pause (`confirmWrite`), at
// the engine's pace of the page. Every answer is journaled first; the
// receipt of each sync (list, size before and after, added, removed, what
// was withheld and why) is the row's cursor `last`, its proof and result
// (`sync work list --resource fan-set-lists.sync`).

interface FanSetListCycle {
  id: number;
  startedAt: string;
  settings: CrossSpendersListSetting;
  settingsKey: string;
  phase: "create" | "items" | "write";
  listRef: string | null;
  created: boolean;
  /** The list's count as `/lists/account` served it. */
  itemCount: number | null;
  /** The members the walk read (the list's Fansly account ids). */
  members: string[];
  after: string | null;
  pages: number;
  /** Set once the walk is done: the set's size, its lookup misses, the
   *  removals it computed (withheld or not). */
  setSize: number | null;
  lookupMisses: number;
  toRemove: number;
  withheld: string | null;
  writes: FanSetListWrite[];
  index: number;
  added: number;
  removed: number;
}

export interface FanSetListReceipt {
  cycle: number;
  endedAt: string;
  /** `synced`: every write went; `cut`: the sync ended at `reason`. */
  outcome: "synced" | "cut";
  reason: string | null;
  listRef: string | null;
  label: string;
  created: boolean;
  /** Members the walk read (null: it did not finish). */
  sizeBefore: number | null;
  /** The list after the writes (null: the sync was cut). */
  sizeAfter: number | null;
  setSize: number | null;
  lookupMisses: number;
  added: number;
  removed: number;
  withheld: string | null;
  withheldRemovals: number;
  settingsKey: string;
}

export interface FanSetListCursor {
  /** The id the last sync of this row took. */
  cycles: number;
  /** Hub's list on the page: the one it made or found, and its label then. */
  list: { listRef: string; label: string } | null;
  cycle: FanSetListCycle | null;
  last: FanSetListReceipt | null;
}

type Step =
  | { phase: "lists"; cycle: number; settings: CrossSpendersListSetting; settingsKey: string }
  | { phase: "items"; cycle: number; after: string | null }
  | { phase: "create"; cycle: number }
  | { phase: "write"; cycle: number; index: number };

/** The set a sync reads: every qualifying account and those of them the
 *  page's account lookup no longer returns; or why it cannot be read. */
export type FanSetListSet =
  | { kind: "ok"; accountIds: string[]; lookupMisses: string[] }
  | { kind: "refused"; reason: string };

/** The database as this module uses it (tests pass their own). */
export interface FanSetListStore {
  getAttempt(db: Database, attemptId: number): Promise<Pick<SyncAttemptRow, "outcome" | "applyState" | "errorClass" | "httpStatus" | "request" | "operation"> | null>;
  getWork(db: Database, workId: number): Promise<Pick<SyncWorkRow, "pageId" | "cursor" | "lastAttemptId"> | null>;
  pageLabel(db: Database, pageId: number): Promise<string | null>;
  readSet(db: Database, input: { pageId: number; setting: CrossSpendersListSetting }): Promise<FanSetListSet>;
}

/** The cross-page spenders of a page as its list holds them: Fansly
 *  account ids, every live page a candidate. */
async function readSet(db: Database, input: { pageId: number; setting: CrossSpendersListSetting }): Promise<FanSetListSet> {
  const candidates = await listCrossPageCandidatePages(db);
  const target = candidates.find((page) => page.id === input.pageId);
  if (target === undefined) return { kind: "refused", reason: "target_page_missing" };
  let sources;
  try {
    sources = resolveCrossPageSources({ target, candidates, sources: input.setting.sources });
  } catch (error) {
    if (error instanceof CrossPageSourceRefusal) return { kind: "refused", reason: `source_${error.reason}:${error.pageLabel}` };
    throw error;
  }
  const set = await readCrossPageSpenders(db, {
    target,
    sources,
    audience: input.setting.audience,
    minSourceSpendMills: millsFromInteger(input.setting.minSourceSpendMills),
    maxTargetSpendMills: input.setting.maxTargetSpendMills === null ? null : millsFromInteger(input.setting.maxTargetSpendMills),
  });
  return {
    kind: "ok",
    accountIds: set.fans.map((fan) => fan.platformUserId),
    lookupMisses: set.fans.filter((fan) => fan.accountLookupMissAt !== null).map((fan) => fan.platformUserId),
  };
}

export const databaseFanSetListStore: FanSetListStore = {
  getAttempt: (db, attemptId) => getSyncAttempt(db, attemptId),
  getWork: (db, workId) => getSyncWork(db, workId),
  async pageLabel(db, pageId) {
    const result = await db.execute<{ label: string }>(sql`select label from pages where id = ${pageId}`);
    return result.rows[0]?.label ?? null;
  },
  readSet,
};

// ── the cursor ──────────────────────────────────────────────────────────────

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^\d{1,30}$/.test(item)) : [];
}

function settingOf(value: unknown): CrossSpendersListSetting | null {
  const record = recordOf(value);
  const sources = record.sources === "model" || record.sources === "all" ? record.sources : Array.isArray(record.sources) ? record.sources.filter((item): item is string => typeof item === "string") : null;
  const min = count(record.minSourceSpendMills);
  const max = record.maxTargetSpendMills === null ? null : count(record.maxTargetSpendMills);
  const audience = record.audience === "followers" || record.audience === "subscribers" || record.audience === "any" ? record.audience : null;
  const label = text(record.label);
  if (sources === null || min === null || min < 1 || (record.maxTargetSpendMills !== null && max === null) || audience === null || label === null) return null;
  return { sources, minSourceSpendMills: min, maxTargetSpendMills: max, audience, label };
}

function writesOf(value: unknown): FanSetListWrite[] | null {
  if (!Array.isArray(value)) return null;
  const writes: FanSetListWrite[] = [];
  for (const item of value) {
    const record = recordOf(item);
    const accountIds = ids(record.accountIds);
    if ((record.op !== "add" && record.op !== "remove") || accountIds.length === 0) return null;
    writes.push({ op: record.op, accountIds });
  }
  return writes;
}

function parseCycle(value: unknown): FanSetListCycle | null {
  const record = recordOf(value);
  const id = count(record.id);
  const startedAt = text(record.startedAt);
  const settings = settingOf(record.settings);
  const settingsKey = text(record.settingsKey);
  const phase = record.phase === "create" || record.phase === "items" || record.phase === "write" ? record.phase : null;
  const listRef = text(record.listRef);
  const writes = writesOf(record.writes ?? []);
  const index = count(record.index) ?? 0;
  if (id === null || id < 1 || startedAt === null || settings === null || settingsKey === null || phase === null || writes === null) return null;
  if (phase !== "create" && listRef === null) return null;
  if (phase === "write" && index >= writes.length) return null;
  return {
    id,
    startedAt,
    settings,
    settingsKey,
    phase,
    listRef,
    created: record.created === true,
    itemCount: count(record.itemCount),
    members: ids(record.members),
    after: text(record.after),
    pages: count(record.pages) ?? 0,
    setSize: count(record.setSize),
    lookupMisses: count(record.lookupMisses) ?? 0,
    toRemove: count(record.toRemove) ?? 0,
    withheld: text(record.withheld),
    writes,
    index,
    added: count(record.added) ?? 0,
    removed: count(record.removed) ?? 0,
  };
}

function parseReceipt(value: unknown): FanSetListReceipt | null {
  const record = recordOf(value);
  const cycle = count(record.cycle);
  const endedAt = text(record.endedAt);
  const settingsKey = text(record.settingsKey);
  if (cycle === null || endedAt === null || settingsKey === null || (record.outcome !== "synced" && record.outcome !== "cut")) return null;
  return {
    cycle,
    endedAt,
    outcome: record.outcome,
    reason: text(record.reason),
    listRef: text(record.listRef),
    label: typeof record.label === "string" ? record.label : "",
    created: record.created === true,
    sizeBefore: count(record.sizeBefore),
    sizeAfter: count(record.sizeAfter),
    setSize: count(record.setSize),
    lookupMisses: count(record.lookupMisses) ?? 0,
    added: count(record.added) ?? 0,
    removed: count(record.removed) ?? 0,
    withheld: text(record.withheld),
    withheldRemovals: count(record.withheldRemovals) ?? 0,
    settingsKey,
  };
}

export function parseFanSetListCursor(value: unknown): FanSetListCursor {
  const record = recordOf(value);
  const list = recordOf(record.list);
  const listRef = text(list.listRef);
  const label = text(list.label);
  return {
    cycles: count(record.cycles) ?? 0,
    list: listRef === null || label === null ? null : { listRef, label },
    cycle: record.cycle == null ? null : parseCycle(record.cycle),
    last: record.last == null ? null : parseReceipt(record.last),
  };
}

function stepOf(value: unknown): Step | null {
  const record = recordOf(value);
  const cycle = count(record.cycle);
  if (cycle === null) return null;
  switch (record.phase) {
    case "lists": {
      const settings = settingOf(record.settings);
      const settingsKey = text(record.settingsKey);
      return settings === null || settingsKey === null ? null : { phase: "lists", cycle, settings, settingsKey };
    }
    case "items":
      return { phase: "items", cycle, after: text(record.after) };
    case "create":
      return { phase: "create", cycle };
    case "write": {
      const index = count(record.index);
      return index === null ? null : { phase: "write", cycle, index };
    }
    default:
      return null;
  }
}

function sameWriteStep(a: Step | null, b: Step): boolean {
  if (a === null || a.phase !== b.phase || a.cycle !== b.cycle) return false;
  return a.phase !== "write" || (b.phase === "write" && a.index === b.index);
}

// ── the steps ───────────────────────────────────────────────────────────────

/** The write a cycle stands at: the create, or its next add or remove. */
function pendingWrite(cycle: FanSetListCycle): RequestPlan | null {
  if (cycle.phase === "create") {
    return { spec: "lists.create", params: { label: cycle.settings.label } satisfies FanslyWireParams<"lists.create">, step: { phase: "create", cycle: cycle.id } satisfies Step };
  }
  if (cycle.phase !== "write" || cycle.listRef === null) return null;
  const write = cycle.writes[cycle.index];
  if (write === undefined) return null;
  return {
    spec: write.op === "add" ? "lists.add" : "lists.remove",
    params: { listId: cycle.listRef, accountIds: write.accountIds } satisfies FanslyWireParams<"lists.add">,
    step: { phase: "write", cycle: cycle.id, index: cycle.index } satisfies Step,
  };
}

function cut(cycle: FanSetListCycle, reason: string): StepPlan {
  return { kind: "local", reason: "fan_set_list_cut", detail: { cycle: cycle.id, reason } };
}

function receiptOf(cycle: FanSetListCycle, outcome: "synced" | "cut", reason: string | null, now: Date): FanSetListReceipt {
  const walked = cycle.phase === "write";
  return {
    cycle: cycle.id,
    endedAt: now.toISOString(),
    outcome,
    reason,
    listRef: cycle.listRef,
    label: cycle.settings.label,
    created: cycle.created,
    sizeBefore: walked ? cycle.members.length : null,
    sizeAfter: outcome === "synced" ? cycle.members.length + cycle.added - cycle.removed : null,
    setSize: cycle.setSize,
    lookupMisses: cycle.lookupMisses,
    added: cycle.added,
    removed: cycle.removed,
    withheld: cycle.withheld,
    withheldRemovals: cycle.withheld === null ? 0 : cycle.toRemove,
    settingsKey: cycle.settingsKey,
  };
}

/** The sync is over: its receipt is the row's last word. The row stays open
 *  (a standing walk), due at once: its plan decides when the next one is. */
function finish(cursor: FanSetListCursor, cycle: FanSetListCycle, outcome: "synced" | "cut", reason: string | null, now: Date): ApplyResult {
  const receipt = receiptOf(cycle, outcome, reason, now);
  return {
    work: {
      satisfiesRevision: true,
      nextDueAt: now,
      cursor: { ...cursor, cycle: null, last: receipt } satisfies FanSetListCursor,
      proof: receipt,
      result: receipt,
    },
    followups: [],
    counters: { [`fan_set_list_${outcome}`]: 1, ...(cycle.withheld === null ? {} : { fan_set_list_removals_withheld: 1 }) },
  };
}

function next(cursor: FanSetListCursor, cycle: FanSetListCycle, now: Date, counters?: Record<string, number>): ApplyResult {
  return {
    work: { satisfiesRevision: false, nextDueAt: now, cursor: { ...cursor, cycle } satisfies FanSetListCursor },
    followups: [],
    ...(counters === undefined ? {} : { counters }),
  };
}

/** An answer that is not the step the cursor stands at (a stale attempt):
 *  journaled, and nothing is made of it. */
function stale(now: Date): ApplyResult {
  return { work: { satisfiesRevision: false, nextDueAt: now }, followups: [], counters: { fan_set_list_step_stale: 1 } };
}

function canWrite(ctx: Pick<PlanContext, "transportWrites">, spec: FanslyWireId): boolean {
  return ctx.transportWrites?.(fanslyWritePermission(spec), spec) === true;
}

async function liveSetting(settings: { read(): Promise<AppConfig> } | undefined, pageLabel: string | null): Promise<CrossSpendersListSetting | null> {
  // Fail closed: no live settings, no list.
  const config = settings === undefined ? null : await settings.read();
  return config === null ? null : crossSpendersListFor(config.crossSpendersLists, pageLabel);
}

export function fanSetListsModule(store: FanSetListStore = databaseFanSetListStore): ResourceModule {
  /** The walk is done (or the list is new): read the set, diff, and go on to
   *  the writes, or finish when there is nothing to write. */
  async function afterWalk(tx: Database, input: ApplyInput, cursor: FanSetListCursor, walked: FanSetListCycle): Promise<ApplyResult> {
    const now = input.observation.receivedAt;
    const set = await store.readSet(tx, { pageId: input.pageId, setting: walked.settings });
    if (set.kind === "refused") return finish(cursor, { ...walked, phase: "items" }, "cut", set.reason, now);
    const diff = diffFanSetList({ members: walked.members, set: set.accountIds, ignored: set.lookupMisses });
    const cycle: FanSetListCycle = {
      ...walked,
      phase: "write",
      after: null,
      setSize: set.accountIds.length,
      lookupMisses: set.lookupMisses.length,
      toRemove: diff.toRemove.length,
      withheld: diff.withheld,
      writes: diff.writes,
      index: 0,
    };
    if (diff.writes.length === 0) return finish(cursor, cycle, "synced", null, now);
    return next(cursor, cycle, input.now, { fan_set_list_writes_planned: diff.writes.length });
  }

  return {
    async plan(work, ctx): Promise<StepPlan> {
      const cursor = parseFanSetListCursor(work.cursor);
      const now = ctx.now;
      const setting = await liveSetting(ctx.settings, ctx.page.pageLabel);
      const cycle = cursor.cycle;
      if (cycle !== null) {
        if (setting === null || crossSpendersListKey(setting) !== cycle.settingsKey) return cut(cycle, "settings_changed");
        if (now.getTime() - Date.parse(cycle.startedAt) > FAN_SET_LIST_CYCLE_MAX_MS) return cut(cycle, "cycle_expired");
        if (cycle.phase === "items") {
          return {
            kind: "request",
            request: {
              spec: "lists.items",
              params: { listId: cycle.listRef!, after: cycle.after } satisfies FanslyWireParams<"lists.items">,
              step: { phase: "items", cycle: cycle.id, after: cycle.after } satisfies Step,
            },
          };
        }
        const write = pendingWrite(cycle);
        if (write === null) return cut(cycle, "nothing_pending");
        // One attempt: a write the row's last attempt sent is never planned again.
        if (work.lastAttemptId !== null) {
          const attempt = await store.getAttempt(ctx.db, work.lastAttemptId);
          if (attempt === null) return cut(cycle, "attempt_missing");
          if (sameWriteStep(stepOf(requestOfAttempt(attempt).step), write.step as Step)) {
            const verdict = writeAttemptVerdict(attempt);
            if (verdict.kind === "pending") return { kind: "wait", reason: "dependency", until: new Date(now.getTime() + FAN_SET_LIST_AWAIT_MS) };
            return cut(cycle, verdict.reason);
          }
        }
        if (!isFanslyWriteSendable(write.spec)) return cut(cycle, "route_unverified");
        // The page's browser between owners or its permission being set
        // again: a while (the sync's own age bounds it), never a send now.
        if (!canWrite(ctx, write.spec)) return { kind: "wait", reason: "dependency", until: new Date(now.getTime() + FAN_SET_LIST_TRANSPORT_RECHECK_MS) };
        return { kind: "request", request: write };
      }

      const recheck = new Date(now.getTime() + FAN_SET_LIST_RECHECK_MS);
      if (setting === null) return { kind: "wait", reason: "not_due", until: recheck };
      const settingsKey = crossSpendersListKey(setting);
      const due = nextFanSetListSyncAt(cursor.last, settingsKey, now);
      if (due.getTime() > now.getTime()) return { kind: "wait", reason: "not_due", until: due.getTime() < recheck.getTime() ? due : recheck };
      // No list is touched by a page that cannot write it now.
      if (!canWrite(ctx, "lists.add")) return { kind: "wait", reason: "dependency", until: recheck };
      return {
        kind: "request",
        request: {
          spec: "lists.account",
          params: {} satisfies FanslyWireParams<"lists.account">,
          step: { phase: "lists", cycle: cursor.cycles + 1, settings: setting, settingsKey } satisfies Step,
        },
      };
    },

    async confirmWrite(db, work, input: ConfirmWriteInput): Promise<string | null> {
      const fresh = await store.getWork(db, work.id);
      if (fresh === null || fresh.pageId !== work.pageId) return "work_missing";
      if (fresh.lastAttemptId !== input.attemptId) return "attempt_not_current";
      const cycle = parseFanSetListCursor(fresh.cursor).cycle;
      const write = cycle === null ? null : pendingWrite(cycle);
      if (cycle === null || write === null) return "no_write_pending";
      if (describeFanslyWrite(write.spec, write.params as never).fingerprint !== input.writeFingerprint) return "fingerprint_mismatch";
      const setting = await liveSetting(input.settings, await store.pageLabel(db, work.pageId));
      if (setting === null) return "list_off";
      if (crossSpendersListKey(setting) !== cycle.settingsKey) return "settings_changed";
      return null;
    },

    outcome(decision: OutcomeDecision, step): OutcomeDecision {
      // A write that is not a 2xx to apply never goes back on a breaker's
      // ladder: due at once, its plan cuts the sync from the attempt.
      return isFanslyWriteWireId(step.request.spec) ? writeOutcomeDecision(decision) : decision;
    },

    async apply(tx, input: ApplyInput): Promise<ApplyResult> {
      const cursor = parseFanSetListCursor(input.work.cursor);
      const step = stepOf(input.request.step);
      const cycle = cursor.cycle;
      const now = input.observation.receivedAt;
      const spec = input.request.spec;

      if (step?.phase === "lists" && spec === "lists.account") {
        if (cycle !== null || step.cycle !== cursor.cycles + 1) return stale(input.now);
        const lists = parseFanListsAnswer(input.response);
        if (lists === null) throw new ApplyQuarantine("fan_set_list_response_invalid", { spec });
        const base: FanSetListCursor = { ...cursor, cycles: step.cycle };
        const started: FanSetListCycle = {
          id: step.cycle, startedAt: now.toISOString(), settings: step.settings, settingsKey: step.settingsKey,
          phase: "items", listRef: null, created: false, itemCount: null, members: [], after: null, pages: 0,
          setSize: null, lookupMisses: 0, toRemove: 0, withheld: null, writes: [], index: 0, added: 0, removed: 0,
        };
        const found = resolveHubList(lists, cursor.list, step.settings.label);
        if (found.kind === "ambiguous") return finish(base, started, "cut", "label_ambiguous", now);
        if (found.kind === "absent") return next(base, { ...started, phase: "create" }, input.now);
        return next(
          { ...base, list: { listRef: found.listRef, label: step.settings.label } },
          { ...started, listRef: found.listRef, itemCount: found.itemCount },
          input.now,
        );
      }

      if (step?.phase === "items" && spec === "lists.items") {
        if (cycle?.phase !== "items" || step.cycle !== cycle.id || step.after !== cycle.after || cycle.listRef === null) return stale(input.now);
        const items = parseFanListItemsAnswer(input.response, cycle.listRef);
        if (items === null) throw new ApplyQuarantine("fan_set_list_response_invalid", { spec });
        if (items.length === 0) return afterWalk(tx, input, cursor, cycle);
        const members = [...new Set([...cycle.members, ...items.map((item) => item.fanRef)])];
        const after = items[items.length - 1]!.sortId;
        const walked: FanSetListCycle = { ...cycle, members, after, pages: cycle.pages + 1 };
        if (after === cycle.after) return finish(cursor, walked, "cut", "cursor_repeated", now);
        if (walked.pages >= FAN_SET_LIST_MAX_PAGES) return finish(cursor, walked, "cut", "page_cap", now);
        return next(cursor, walked, input.now);
      }

      if (step?.phase === "create" && spec === "lists.create") {
        if (cycle?.phase !== "create" || step.cycle !== cycle.id) return stale(input.now);
        const listRef = readListCreateAnswer(input.response);
        // The list may stand all the same: the next sync finds it by its label.
        if (listRef === null) return finish(cursor, cycle, "cut", "create_answer_unreadable", now);
        return afterWalk(
          tx,
          input,
          { ...cursor, list: { listRef, label: cycle.settings.label } },
          { ...cycle, phase: "items", listRef, created: true, itemCount: 0, members: [] },
        );
      }

      if (step?.phase === "write" && (spec === "lists.add" || spec === "lists.remove")) {
        if (cycle?.phase !== "write" || step.cycle !== cycle.id || step.index !== cycle.index || cycle.listRef === null) return stale(input.now);
        const write = cycle.writes[cycle.index]!;
        const named = readListWriteAnswer(write, cycle.listRef, input.response);
        if (named === null) return finish(cursor, cycle, "cut", "write_answer_unreadable", now);
        const done: FanSetListCycle = {
          ...cycle,
          index: cycle.index + 1,
          added: cycle.added + (write.op === "add" ? named : 0),
          removed: cycle.removed + (write.op === "remove" ? named : 0),
        };
        const counters = { [write.op === "add" ? "fan_set_list_added" : "fan_set_list_removed"]: named };
        if (done.index >= done.writes.length) {
          const finished = finish(cursor, done, "synced", null, now);
          return { ...finished, counters: { ...finished.counters, ...counters } };
        }
        return next(cursor, done, input.now, counters);
      }

      return stale(input.now);
    },

    async applyLocal(_tx, input: LocalApplyInput): Promise<ApplyResult> {
      const detail = recordOf(input.plan?.detail);
      const cursor = parseFanSetListCursor(input.work.cursor);
      const cycle = cursor.cycle;
      const reason = text(detail.reason);
      // A cut the plan decided for a sync that is still the row's.
      if (cycle === null || reason === null || count(detail.cycle) !== cycle.id) {
        return { work: { satisfiesRevision: false, nextDueAt: input.now }, followups: [] };
      }
      return finish(cursor, cycle, "cut", reason, input.now);
    },
  };
}
