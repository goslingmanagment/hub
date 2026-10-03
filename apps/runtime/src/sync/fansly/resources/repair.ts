import {
  countUnservedWorkForKeys,
  readFanslyWsGapPass,
  stampFanslyWsGapReconciled,
  SYNC_WS_GAP_MARGIN_MS,
} from "@agency_hub_core/db";
import { FANSLY_MESSAGING_GROUPS_PAGE_LIMIT, type FanslyMessagingGroupsPage } from "@agency_hub_core/fansly";

import { ApplyQuarantine } from "../../engine/commit.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  LocalApplyInput,
  PlanContext,
  RequestPlan,
  ResourceModule,
  ShadowResult,
  StepPlan,
} from "../../engine/resource.ts";
import { listHeadInstant } from "../lib/conversation-list.ts";
import { readFanslyPageFacts, waitForPageIdentity } from "../lib/page-facts.ts";
import { applyListPage } from "./dm-conversations.ts";

// `repair.ws-gap` (live only, step 3; design S3-04 item 5, §5.21, G17, E19):
// what the socket may have missed while it was down is read again, once per
// gap, instead of trusting the next frames. Demand comes from the socket owner
// on every new verified connection (`onUp`) and from the router when a frame
// names no chat (plan §7 p.10 (b)); the work carries no window of its own — an
// open row keeps the parameters of its first demand, and a router repair has
// none — so each PASS derives its window from the page's verified socket
// connections no repair has reconciled yet (`readFanslyWsGapPass`): from the
// earliest gap they record, 60 s earlier; with none, from the work's first
// demand, 60 s earlier.
//
// A pass:
//   list  — the conversation list from offset 0, one page per step through the
//           list's own apply (`applyListPage`), every chat whose head moved
//           read at once (`dm-messages.head`, urgent, as `.ws-down` does);
//           the next page while the page is full and its oldest chat is not
//           older than the window's start. How close two list pages go is
//           the list route's budget (12/min, owner decisions №14, №21: the
//           actor's route admission, whatever pulled the row forward — a new
//           demand, a restarted pass); a list 429 holds only the list keys,
//           this one among them;
//   then  — the money head (`transactions.head`, urgent) and the subscribers
//           poll (due now), the two other things a socket says live;
//   wait  — until every work the pass asked for has served its demand, or
//           10 min passed;
//   stamp — (`local`, no request) the pass's connections reconciled:
//           `state_reconciled_at`, and `transient_unknown` over the gap (a
//           message created and deleted inside it is not recoverable, plan
//           §8). If demand arrived during the pass (a reconnect, an
//           unbindable frame) a new pass starts on the same row; else the work
//           closes.

export const REPAIR_KEY = "repair.ws-gap";
/** The pass waits at most this long for the work it asked for. */
export const REPAIR_WAIT_MAX_MS = 10 * 60_000;
/** The wait looks again this often. */
export const REPAIR_WAIT_RECHECK_MS = 5_000;
/** At most this many asked-for keys are remembered for the wait. */
export const REPAIR_SPAWNED_CAP = 2_000;

const LIMIT = FANSLY_MESSAGING_GROUPS_PAGE_LIMIT;
const MONEY_HEAD_KEY = "transactions.head";
const SUBSCRIBERS_KEY = "subscribers.poll";
const DEMAND_REASON = "ws_gap";

/** The window and the connections of one pass, fixed when it starts. */
export interface RepairPass {
  /** ISO: the window's start (the earliest gap − 60 s). */
  since: string;
  /** The connections the pass stamps (uuid text). */
  targets: string[];
  /** `sync_work.demand_revision` when the pass started. */
  startedRevision: number;
}

export interface RepairCursor {
  phase: "list" | "wait";
  pass: RepairPass;
  /** The next list offset (list phase). */
  offset: number;
  pageCount: number;
  /** The work the pass asked for, by key (the wait reads their revisions). */
  spawned: Array<{ resource: string; subject: string }>;
  /** ISO: when the wait began (wait phase). */
  waitStartedAt: string | null;
}

/** What one list step carries from its plan to its apply. */
interface RepairStep {
  pass: RepairPass;
  offset: number;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function iso(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function parsePass(value: unknown): RepairPass | null {
  const record = recordOf(value);
  const since = iso(record.since);
  const startedRevision = count(record.startedRevision);
  if (since === null || startedRevision === null || !Array.isArray(record.targets)) return null;
  return { since, targets: record.targets.filter((target): target is string => typeof target === "string"), startedRevision };
}

/** The work's cursor, or null for a work that has no pass under way. */
export function parseRepairCursor(value: unknown): RepairCursor | null {
  const record = recordOf(value);
  const pass = parsePass(record.pass);
  const phase = record.phase === "list" || record.phase === "wait" ? record.phase : null;
  const offset = count(record.offset);
  if (pass === null || phase === null || offset === null) return null;
  const spawned = Array.isArray(record.spawned)
    ? record.spawned.flatMap((entry: unknown) => {
      const key = recordOf(entry);
      return typeof key.resource === "string" && typeof key.subject === "string" ? [{ resource: key.resource, subject: key.subject }] : [];
    })
    : [];
  return {
    phase,
    pass,
    offset,
    pageCount: count(record.pageCount) ?? 0,
    spawned,
    waitStartedAt: iso(record.waitStartedAt),
  };
}

function parseStep(value: unknown): RepairStep | null {
  const record = recordOf(recordOf(value).repair);
  const pass = parsePass(record.pass);
  const offset = count(record.offset);
  return pass === null || offset === null ? null : { pass, offset };
}

function listStep(step: RepairStep): RequestPlan<"messaging.groups"> {
  return { spec: "messaging.groups", params: { offset: step.offset }, step: { repair: step } };
}

/** The keys a pass asked for, first seen first, deduplicated and capped. */
function mergeSpawned(
  known: ReadonlyArray<{ resource: string; subject: string }>,
  signals: readonly DemandSignal[],
): Array<{ resource: string; subject: string }> {
  const seen = new Set(known.map((key) => `${key.resource}\u0000${key.subject}`));
  const merged = [...known];
  for (const signal of signals) {
    const key = { resource: signal.resource, subject: signal.subject ?? "" };
    const id = `${key.resource}\u0000${key.subject}`;
    if (seen.has(id) || merged.length >= REPAIR_SPAWNED_CAP) continue;
    seen.add(id);
    merged.push(key);
  }
  return merged;
}

/** The oldest head instant a served list page shows (null: none known). */
function oldestHeadOf(items: Awaited<ReturnType<typeof applyListPage>>["items"]): Date | null {
  let oldest: Date | null = null;
  for (const item of items) {
    const at = item.head.servedAt ?? listHeadInstant(item.head.listMessageId, null);
    if (at !== null && (oldest === null || at.getTime() < oldest.getTime())) oldest = at;
  }
  return oldest;
}

async function planList(ctx: PlanContext, step: RepairStep): Promise<StepPlan> {
  // The list apply tells the page's own account from the partner.
  const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
  if (facts === null) return { kind: "quarantine", reason: "page_missing" };
  if (facts.externalId === null) return waitForPageIdentity(REPAIR_KEY, ctx.shadow, ctx.now);
  return { kind: "request", request: listStep(step) };
}

export const repairWsGapModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    // Live only: a shadow page has no socket and no gap of its own (I14).
    if (ctx.shadow) return { kind: "done", reason: "shadow_no_socket" };
    const cursor = parseRepairCursor(work.cursor);
    if (cursor === null) {
      // A new pass: its window and targets, read-only; they travel with the
      // first list step and become the cursor in its apply.
      const gap = await readFanslyWsGapPass(ctx.db, { pageId: ctx.pageId });
      const since = gap.since ?? new Date(work.firstDemandAt.getTime() - SYNC_WS_GAP_MARGIN_MS);
      return planList(ctx, {
        pass: { since: since.toISOString(), targets: gap.targets, startedRevision: work.demandRevision },
        offset: 0,
      });
    }
    if (cursor.phase === "list") return planList(ctx, { pass: cursor.pass, offset: cursor.offset });
    const waitStartedMs = Date.parse(cursor.waitStartedAt ?? ctx.now.toISOString());
    const deadlineMs = waitStartedMs + REPAIR_WAIT_MAX_MS;
    if (ctx.now.getTime() < deadlineMs) {
      const unserved = await countUnservedWorkForKeys(ctx.db, { pageId: ctx.pageId, keys: cursor.spawned });
      if (unserved > 0) {
        const until = new Date(Math.min(ctx.now.getTime() + REPAIR_WAIT_RECHECK_MS, deadlineMs));
        return { kind: "wait", reason: "dependency", until };
      }
    }
    return { kind: "local", reason: "ws_gap_stamp" };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const step = parseStep(input.request.step);
    if (step === null) throw new ApplyQuarantine("repair_step_missing");
    const prior = parseRepairCursor(input.work.cursor);
    const expectedOffset = prior === null ? 0 : prior.offset;
    if ((prior !== null && prior.phase !== "list") || step.offset !== expectedOffset) {
      throw new ApplyQuarantine("repair_cursor_mismatch", { stepOffset: step.offset, cursorOffset: expectedOffset });
    }
    const page = input.parsed as FanslyMessagingGroupsPage;
    // The socket was down: the list is the live signal, every chat whose head
    // moved is read now.
    const outcome = await applyListPage(tx, {
      pageId: input.pageId,
      now: input.now,
      key: REPAIR_KEY,
      page,
      generation: null,
      classOf: () => "urgent",
    });
    const pass = step.pass;
    const pageCount = (prior?.pageCount ?? 0) + 1;
    const oldest = oldestHeadOf(outcome.items);
    const more = page.data.length >= LIMIT && oldest !== null && oldest.getTime() >= Date.parse(pass.since);
    const counters = { ...outcome.counters, repair_list_pages: 1 };
    if (more) {
      return {
        work: {
          satisfiesRevision: false,
          cursor: {
            phase: "list",
            pass,
            offset: step.offset + LIMIT,
            pageCount,
            spawned: mergeSpawned(prior?.spawned ?? [], outcome.followups),
            waitStartedAt: null,
          } satisfies RepairCursor,
          // The list route's budget spaces the next page (the actor's route
          // admission).
          nextDueAt: input.now,
        },
        followups: outcome.followups,
        counters,
      };
    }
    // The list reached the window's start: the money head and the
    // subscribers poll too, then wait for all of it.
    const live: DemandSignal[] = [
      { resource: MONEY_HEAD_KEY, demand: { reason: DEMAND_REASON } },
      { resource: SUBSCRIBERS_KEY, dueAt: input.now, demand: { reason: DEMAND_REASON } },
    ];
    const followups = [...outcome.followups, ...live];
    return {
      work: {
        satisfiesRevision: false,
        cursor: {
          phase: "wait",
          pass,
          offset: step.offset,
          pageCount,
          spawned: mergeSpawned(prior?.spawned ?? [], followups),
          waitStartedAt: input.now.toISOString(),
        } satisfies RepairCursor,
        nextDueAt: input.now,
      },
      followups,
      counters,
    };
  },

  async applyLocal(tx, input: LocalApplyInput): Promise<ApplyResult> {
    const cursor = parseRepairCursor(input.work.cursor);
    if (cursor === null || cursor.phase !== "wait") {
      // Nothing to stamp yet (the cursor is not at its wait): start over.
      return { work: { satisfiesRevision: false, cursor: {}, nextDueAt: input.now }, followups: [] };
    }
    const stamped = await stampFanslyWsGapReconciled(tx, {
      pageId: input.pageId,
      targets: cursor.pass.targets,
      since: new Date(cursor.pass.since),
    });
    const result = {
      since: cursor.pass.since,
      targets: cursor.pass.targets.length,
      stamped,
      listPages: cursor.pageCount,
      asked: cursor.spawned.length,
      at: input.now.toISOString(),
    };
    // A reconnect or an unbindable frame during the pass: a new pass on the
    // same row (its window and targets are read again); else the work is done.
    if (input.work.demandRevision > cursor.pass.startedRevision) {
      // The new pass's first list page meets the list route's budget like
      // any other.
      return {
        work: {
          satisfiesRevision: false,
          cursor: {},
          result,
          nextDueAt: input.now,
        },
        followups: [],
        counters: { repair_stamped: stamped, repair_passes_restarted: 1 },
      };
    }
    return {
      work: { satisfiesRevision: true, close: "done", closeReason: "gap_reconciled", cursor: {}, result },
      followups: [],
      counters: { repair_stamped: stamped },
    };
  },

  async shadow(): Promise<ShadowResult> {
    // Live only (the registry's `liveOnly`): a shadow page never runs it.
    return { work: { satisfiesRevision: true, close: "done", closeReason: "shadow" }, followups: [] };
  },
};
