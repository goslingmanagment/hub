import { upsertFans, upsertPageTopSpenders, type Database } from "@agency_hub_core/db";
import type { FanslyEarningsAccount } from "@agency_hub_core/fansly";
import { millsFromInteger } from "@agency_hub_core/shared";

import { parseFanslyMetadataAccountCreatedAt } from "../../../services/fansly.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  RequestPlan,
  ResourceModule,
  StepPlan,
} from "../../engine/resource.ts";
import {
  buildTopSpendersBootstrapState,
  buildTopSpendersBootstrapWindows,
  buildUtcMonthKey,
  computeCompletedTopSpenderMonths,
  parseTopSpendersCursorState,
  partitionTopSpenderItems,
  splitTopSpendersWindow,
  TOP_SPENDERS_PROVIDER_CAP,
  TOP_SPENDERS_STEADY_STATE_WINDOW_MS,
  type TopSpendersCursorState,
  type TopSpendersCursorWindow,
} from "../lib/money-rules.ts";
import { readFanslyPageFacts } from "../lib/page-facts.ts";

// `top-spenders.window` and `.bootstrap` (design §5.7): the page's spenders
// ranked by `/account/wallets/earnings/accounts?after=<ms>&before=<ms>`,
// journaled as `earnings_accounts` (raw-only; never canonicalized) and
// written straight into `page_fan_identities` (`upsertFans` +
// `upsertPageTopSpenders`, the legacy `upsertTopSpendersWindow` without its
// owned transaction).
//
// - window (planned poll, every 6 h, owner decision 2026-09-30): the trailing
//   7 days.
// - bootstrap (owner, a new page): one window per UTC month since the
//   account was created (`pages.metadata.accountCreatedAt`, written by
//   `account.poll`, which the walk waits for when it is missing).
// The provider serves at most 100 rows: a full answer splits its window —
// month → weeks → days — and a full day is kept as served (truncated, counted).
// Nothing reads these rankings today; the resource stays because of the
// owner's 6-hour decision. The DM streams no longer wait for it.

export type TopSpendersVariant = "window" | "bootstrap";

interface TopSpendersCursor {
  /** Window: the windows of a split steady read still to read. */
  pending: TopSpendersCursorWindow[];
  /** Bootstrap: the legacy-shaped walk state. */
  state: TopSpendersCursorState | null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseWindows(value: unknown): TopSpendersCursorWindow[] {
  const parsed = parseTopSpendersCursorState({
    version: 1,
    mode: "steady_state",
    accountCreatedAt: "1970-01-01T00:00:00.000Z",
    totalMonths: 0,
    completedMonths: 0,
    pendingWindows: Array.isArray(value) ? value : [],
    lastWindowStartedAt: null,
    lastWindowEndedAt: null,
  });
  return parsed?.pendingWindows ?? [];
}

function parseCursor(value: unknown): TopSpendersCursor {
  const record = recordOf(value);
  return { pending: parseWindows(record.pending), state: parseTopSpendersCursorState(record.state) };
}

function windowRequest(window: TopSpendersCursorWindow): RequestPlan<"earnings.accounts"> {
  return {
    spec: "earnings.accounts",
    params: { afterMs: Date.parse(window.startedAt), beforeMs: Date.parse(window.endedAt) },
  };
}

function steadyWindow(now: Date): TopSpendersCursorWindow {
  const startedAt = new Date(now.getTime() - TOP_SPENDERS_STEADY_STATE_WINDOW_MS);
  return { kind: "week", monthKey: buildUtcMonthKey(startedAt), startedAt: startedAt.toISOString(), endedAt: now.toISOString() };
}

/** The window a request read: the planned one when it is the head of
 *  `pending`, else the same span as a window of `kind`. */
function windowOfRequest(
  request: RequestPlan,
  head: TopSpendersCursorWindow | undefined,
  kind: TopSpendersCursorWindow["kind"],
): TopSpendersCursorWindow {
  const params = recordOf(request.params);
  const afterMs = Number(params.afterMs);
  const beforeMs = Number(params.beforeMs);
  if (head !== undefined && Date.parse(head.startedAt) === afterMs && Date.parse(head.endedAt) === beforeMs) return head;
  const startedAt = new Date(afterMs);
  return { kind: head?.kind ?? kind, monthKey: buildUtcMonthKey(startedAt), startedAt: startedAt.toISOString(), endedAt: new Date(beforeMs).toISOString() };
}

/** One read window's rankings (the legacy `upsertTopSpendersWindow`). */
async function writeTopSpendersWindow(
  tx: Database,
  input: { pageId: number; window: TopSpendersCursorWindow; items: readonly FanslyEarningsAccount[] },
): Promise<{ rankings: number; skipped: number }> {
  const { valid, skippedCount } = partitionTopSpenderItems(input.items);
  if (valid.length === 0) return { rankings: 0, skipped: skippedCount };
  const fans = await upsertFans(tx, valid.flatMap((item) => (
    item.correlationAccountId ? [{ platform: "fansly" as const, platformUserId: item.correlationAccountId }] : []
  )));
  const fanIds = new Map(fans.map((fan) => [fan.platformUserId, fan.id] as const));
  const startedAt = new Date(input.window.startedAt);
  const endedAt = new Date(input.window.endedAt);
  await upsertPageTopSpenders(tx, valid.map((item) => ({
    platformAccountId: input.pageId,
    sourceIdentityKey: item.sourceIdentityKey,
    correlationAccountId: item.correlationAccountId,
    accountId: item.accountId,
    fanId: item.correlationAccountId ? (fanIds.get(item.correlationAccountId) ?? null) : null,
    grossAmountMills: millsFromInteger(item.totalGross),
    creatorNetAmountMills: millsFromInteger(item.totalNet),
    sourceWindowStartedAt: startedAt,
    sourceWindowEndedAt: endedAt,
  })));
  return { rankings: valid.length, skipped: skippedCount };
}

interface WindowRead {
  /** The windows still to read after this one (a split puts its parts first). */
  pending: TopSpendersCursorWindow[];
  counters: Record<string, number>;
}

/** Fold one served window: a capped answer splits its window (nothing is
 *  written), anything else is written and leaves the queue. */
async function readWindow(
  tx: Database,
  input: { pageId: number; window: TopSpendersCursorWindow; rest: TopSpendersCursorWindow[]; items: readonly FanslyEarningsAccount[] },
): Promise<WindowRead> {
  const capped = input.items.length >= TOP_SPENDERS_PROVIDER_CAP;
  const finer = capped ? splitTopSpendersWindow(input.window) : null;
  if (finer !== null) return { pending: [...finer, ...input.rest], counters: { window_split: 1 } };
  const written = await writeTopSpendersWindow(tx, { pageId: input.pageId, window: input.window, items: input.items });
  return {
    pending: input.rest,
    counters: {
      rankings: written.rankings,
      ...(written.skipped > 0 ? { missing_identity: written.skipped } : {}),
      ...(capped ? { window_truncated: 1 } : {}),
    },
  };
}

async function accountCreatedAt(db: Database, pageId: number): Promise<Date | null> {
  const facts = await readFanslyPageFacts(db, pageId);
  return facts === null ? null : parseFanslyMetadataAccountCreatedAt(facts.metadata);
}

export function topSpendersModule(variant: TopSpendersVariant): ResourceModule {
  const key = `top-spenders.${variant}`;

  return {
    async plan(work, ctx): Promise<StepPlan> {
      const cursor = parseCursor(work.cursor);
      if (variant === "window") {
        return { kind: "request", request: windowRequest(cursor.pending[0] ?? steadyWindow(ctx.now)) };
      }
      if (cursor.state !== null) {
        const head = cursor.state.pendingWindows[0];
        return head === undefined
          ? { kind: "done", reason: "bootstrap_complete", cursor }
          : { kind: "request", request: windowRequest(head) };
      }
      const created = await accountCreatedAt(ctx.db, ctx.pageId);
      if (created === null) {
        const enqueue: DemandSignal[] = [{ resource: "account.poll", demand: { reason: `dependency:${key}` } }];
        return { kind: "wait", reason: "dependency", until: null, enqueue };
      }
      const first = buildTopSpendersBootstrapWindows(created, ctx.now)[0];
      return first === undefined
        ? { kind: "done", reason: "bootstrap_complete" }
        : { kind: "request", request: windowRequest(first) };
    },

    async apply(tx, input: ApplyInput): Promise<ApplyResult> {
      const items = input.parsed as FanslyEarningsAccount[];
      const cursor = parseCursor(input.work.cursor);
      if (variant === "window") {
        const window = windowOfRequest(input.request, cursor.pending[0], "week");
        const rest = cursor.pending.length > 0 && cursor.pending[0] === window ? cursor.pending.slice(1) : cursor.pending;
        const read = await readWindow(tx, { pageId: input.pageId, window, rest, items });
        const next: TopSpendersCursor = { pending: read.pending, state: null };
        return read.pending.length === 0
          ? {
            work: {
              satisfiesRevision: true,
              close: "done",
              closeReason: "window_read",
              cursor: next,
              proof: { startedAt: window.startedAt, endedAt: window.endedAt, ...read.counters },
            },
            followups: [],
            counters: read.counters,
          }
          : { work: { satisfiesRevision: false, nextDueAt: input.now, cursor: next }, followups: [], counters: read.counters };
      }

      let state = cursor.state;
      if (state === null) {
        const created = await accountCreatedAt(tx, input.pageId);
        if (created === null) throw new Error("top_spenders_bootstrap_without_account_created_at");
        state = buildTopSpendersBootstrapState(created, input.attempt.admittedAt);
      }
      const window = windowOfRequest(input.request, state.pendingWindows[0], "month");
      const rest = state.pendingWindows.slice(1);
      const read = await readWindow(tx, { pageId: input.pageId, window, rest, items });
      state = {
        ...state,
        pendingWindows: read.pending,
        completedMonths: computeCompletedTopSpenderMonths(state.totalMonths, read.pending),
        lastWindowStartedAt: window.startedAt,
        lastWindowEndedAt: window.endedAt,
      };
      if (read.pending.length > 0) {
        return {
          work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { pending: [], state } },
          followups: [],
          counters: read.counters,
        };
      }
      state = { ...state, mode: "steady_state", completedMonths: state.totalMonths };
      return {
        work: {
          satisfiesRevision: true,
          close: "done",
          closeReason: "bootstrap_complete",
          cursor: { pending: [], state },
          proof: { totalMonths: state.totalMonths, accountCreatedAt: state.accountCreatedAt },
        },
        followups: [],
        counters: read.counters,
      };
    },
  };
}
