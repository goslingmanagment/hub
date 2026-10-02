import { sql } from "drizzle-orm";

import { listCaptureCoverage, type Database } from "@agency_hub_core/db";
import { PAYOUT_REQUESTS_PAGE_SIZE } from "@agency_hub_core/fansly";
import { CAPTURE_COVERAGE_PLANES } from "@agency_hub_core/shared";

import { isMappedPayoutStatus } from "../../../services/canonicalize/fansly-payouts.ts";
import { advanceOffsetPage, writeFanslyLaneCoverage } from "../../../services/sync/fansly-lane.ts";
import {
  catchUpReached,
  classifyPayoutResponse,
  FANSLY_PAYOUTS_COVERAGE_SCOPES,
  FANSLY_PAYOUTS_OBSERVATION_KINDS,
  firstPayoutRef,
  oldestCreatedAtMs,
  parseFanslyPayoutsCursorState,
  payoutHeadGap,
  payoutRefs,
  payoutRequestRows,
  payoutRequestTotal,
  payoutWalkStopAt,
  REQUEST_WALK_MAX_PAGES,
  settledPayoutRequestsCoverage,
  settleWalkStop,
  type FanslyPayoutsCatchUp,
  type FanslyPayoutsWalkStop,
} from "../../../services/sync/fansly-payouts.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  LegacyImport,
  ReplayContext,
  ReplayObservation,
  ReplayVerdict,
  ResourceModule,
  ShadowResult,
  StepPlan,
} from "../../engine/resource.ts";

// `payouts.daily` and `payouts.walk` (design §5.10): money OUT —
// `GET /payments/payoutmethods` (journaled verbatim as `payout_methods`; it
// carries the creator's plaintext payout email, so neither kind is on the
// agent allowlist) and `GET /payments/payout/requests?before=&after=&limit=10
// &offset=<n>` (`payout_requests`, the app's exact empty-value form).
//
// - daily (planned poll, 24 h; WS `payoutRequest` and transaction type 16012
//   make it due now, S2-10): two steps — the method listing, then the request
//   head at offset 0. The head seeds the history walk on the page's first
//   read, and re-opens it as a catch-up when a full head shares no row with
//   the previous head (`payoutHeadGap`).
// - walk (planned goal): offset 10, 20, … until a short page or the offset
//   reaches `total`; a catch-up also ends on a page holding a row the previous
//   head held. A page whose first row repeats the previous page's first row is
//   a server ignoring `offset`: the walk stops there. ≤ 400 pages.
// The apply writes the coverage claim (`capture_coverage`, plane `payouts`,
// one scope per route) exactly as the legacy lane: only an exhausted walk
// claims the floor, every other stop names itself and is never upgraded
// (`settleWalkStop`). The canonicalizer (`pull/payouts`) and its projection
// write `page_payout_methods` / `page_payout_requests` from the journal.
// Retired: the daily call budget and the jittered continuations.
//
// A body the lane's own predicate calls invalid is quarantined with the raw
// page kept (legacy threw after journaling it).

export type PayoutsVariant = "daily" | "walk";

export const PAYOUTS_WALK_KEY = "payouts.walk";

interface DailyCursor {
  /** 0: the method listing next; 1: the request head next. */
  step: number;
  /** The row refs of the last head page. */
  headRefs: string[];
  /** `total` as the last head stated it. */
  walkTotal: number | null;
  /** Payout status codes already counted as unknown on this page. */
  unknownStatusCodes: number[];
}

interface WalkCursor {
  offset: number;
  lastRequestedOffset: number | null;
  lastPageFirstRef: string | null;
  pages: number;
  catchUp: FanslyPayoutsCatchUp | null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function parseCatchUp(value: unknown): FanslyPayoutsCatchUp | null {
  const record = recordOf(value);
  const stopRefs = strings(record.stopRefs);
  const untilOffset = intOrNull(record.untilOffset);
  if (stopRefs.length === 0 && untilOffset === null) return null;
  return { stopRefs: stopRefs.length > 0 ? stopRefs : null, untilOffset };
}

function parseDailyCursor(value: unknown): DailyCursor {
  const record = recordOf(value);
  return {
    step: intOrNull(record.step) === 1 ? 1 : 0,
    headRefs: strings(record.headRefs),
    walkTotal: intOrNull(record.walkTotal),
    unknownStatusCodes: Array.isArray(record.unknownStatusCodes)
      ? record.unknownStatusCodes.filter((code): code is number => typeof code === "number" && Number.isSafeInteger(code))
      : [],
  };
}

function parseWalkCursor(cursor: unknown, params: unknown): WalkCursor {
  const record = recordOf(cursor);
  const start = recordOf(params);
  const offset = intOrNull(record.offset);
  if (offset !== null && offset >= 0) {
    return {
      offset,
      lastRequestedOffset: intOrNull(record.lastRequestedOffset),
      lastPageFirstRef: nonEmpty(record.lastPageFirstRef),
      pages: Math.max(0, intOrNull(record.pages) ?? 0),
      catchUp: parseCatchUp(record.catchUp),
    };
  }
  // A new walk starts after the head page the daily step read.
  return {
    offset: Math.max(PAYOUT_REQUESTS_PAGE_SIZE, intOrNull(start.startOffset) ?? PAYOUT_REQUESTS_PAGE_SIZE),
    lastRequestedOffset: 0,
    lastPageFirstRef: nonEmpty(start.lastPageFirstRef),
    pages: 1,
    catchUp: parseCatchUp(start.catchUp),
  };
}

const WALK_STOPS: ReadonlySet<string> = new Set<FanslyPayoutsWalkStop>(["exhausted", "short_before_total", "repeat_request", "page_cap"]);

/** The stop the request history's coverage claims today, or null (no walk
 *  has finished on this page). */
async function currentWalkStop(db: Database, pageId: number): Promise<FanslyPayoutsWalkStop | null> {
  const rows = await listCaptureCoverage(db, { pageId, plane: CAPTURE_COVERAGE_PLANES.payouts });
  const requests = rows.find((row) => row.scopeRef === FANSLY_PAYOUTS_COVERAGE_SCOPES.requests);
  if (requests === undefined) return null;
  if (requests.status === "provider_exhausted") return "exhausted";
  if (requests.status === "partial_provider_surface" && requests.reasonCode !== null && WALK_STOPS.has(requests.reasonCode)) {
    return requests.reasonCode as FanslyPayoutsWalkStop;
  }
  return null;
}

async function openWalkExists(db: Database, pageId: number): Promise<boolean> {
  const result = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from sync_work
     where page_id = ${pageId} and not shadow and resource = ${PAYOUTS_WALK_KEY}
       and state in ('open', 'running', 'quarantined')
  `);
  return Number(result.rows[0]?.n ?? 0) > 0;
}

type CoverageInput = Parameters<typeof writeFanslyLaneCoverage>[0];

async function writeCoverage(
  tx: Database,
  input: { pageId: number; now: Date; scope: string } & Pick<CoverageInput, "status" | "proof" | "proofObservationId" | "reasonCode" | "expectedCount" | "oldestCapturedAt" | "cursor">,
): Promise<void> {
  await writeFanslyLaneCoverage({
    db: tx,
    pageId: input.pageId,
    plane: CAPTURE_COVERAGE_PLANES.payouts,
    scopeRef: input.scope,
    status: input.status,
    acquisitionMode: "retroactive",
    proof: input.proof,
    newestCapturedAt: input.now,
    ...(input.proofObservationId === undefined ? {} : { proofObservationId: input.proofObservationId }),
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    ...(input.expectedCount === undefined ? {} : { expectedCount: input.expectedCount }),
    ...(input.oldestCapturedAt === undefined ? {} : { oldestCapturedAt: input.oldestCapturedAt }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  });
}

/** The request-history claim of a finished walk (legacy
 *  `writeSettledCoverage`): an exhausted walk is proved by the page that
 *  reached the floor; a partial stop only by the page that stopped it. */
async function writeSettledRequestsCoverage(
  tx: Database,
  input: {
    pageId: number;
    now: Date;
    stop: FanslyPayoutsWalkStop | null;
    observationId: number;
    stoppedHere: boolean;
    total: number | null;
    floorMs: number | null;
    cursor: Record<string, unknown>;
  },
): Promise<void> {
  const settled = settledPayoutRequestsCoverage(input.stop);
  const proved = settled.status === "provider_exhausted" || input.stoppedHere;
  await writeCoverage(tx, {
    pageId: input.pageId,
    now: input.now,
    scope: FANSLY_PAYOUTS_COVERAGE_SCOPES.requests,
    status: settled.status,
    proof: proved ? "terminal_response" : "none",
    proofObservationId: proved ? input.observationId : null,
    reasonCode: settled.reasonCode,
    expectedCount: input.total,
    oldestCapturedAt: input.floorMs === null ? null : new Date(input.floorMs),
    cursor: input.cursor,
  });
}

/** The unmapped payout status codes of a page not counted before. */
function unknownStatuses(rows: readonly Record<string, unknown>[], counted: readonly number[]): number[] {
  const seen = new Set(counted);
  const fresh: number[] = [];
  for (const row of rows) {
    const code = intOrNull(row.status);
    if (code === null || isMappedPayoutStatus(code) || seen.has(code)) continue;
    seen.add(code);
    fresh.push(code);
  }
  return fresh;
}

function assertValid(kind: string, response: unknown): void {
  if (classifyPayoutResponse(kind, response) === "invalid") {
    throw new ApplyQuarantine(`${kind}_invalid`);
  }
}

function walkFollowup(start: { lastPageFirstRef: string | null; catchUp: FanslyPayoutsCatchUp | null }, reason: string): DemandSignal {
  return {
    resource: PAYOUTS_WALK_KEY,
    params: { startOffset: PAYOUT_REQUESTS_PAGE_SIZE, lastPageFirstRef: start.lastPageFirstRef, catchUp: start.catchUp },
    demand: { reason },
  };
}

const dailyModule: ResourceModule = {
  async plan(work): Promise<StepPlan> {
    const cursor = parseDailyCursor(work.cursor);
    return cursor.step === 0
      ? { kind: "request", request: { spec: "payouts.methods", params: {} } }
      : { kind: "request", request: { spec: "payouts.requests", params: { offset: 0 } } };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const cursor = parseDailyCursor(input.work.cursor);
    const pageId = input.pageId;
    if (input.request.spec === "payouts.methods") {
      assertValid(FANSLY_PAYOUTS_OBSERVATION_KINDS.payoutMethods, input.response);
      // A full listing in one call is the provider's whole surface.
      await writeCoverage(tx, {
        pageId,
        now: input.now,
        scope: FANSLY_PAYOUTS_COVERAGE_SCOPES.methods,
        status: "provider_exhausted",
        proof: "terminal_response",
        proofObservationId: input.observation.id,
        reasonCode: "full_listing",
      });
      return { work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, step: 1 } }, followups: [] };
    }

    assertValid(FANSLY_PAYOUTS_OBSERVATION_KINDS.payoutRequests, input.response);
    const rows = payoutRequestRows(input.response);
    const total = payoutRequestTotal(input.response);
    const floorMs = oldestCreatedAtMs(rows);
    const unknown = unknownStatuses(rows, cursor.unknownStatusCodes);
    const counters: Record<string, number> = unknown.length > 0 ? { payout_status_unknown: unknown.length } : {};
    const followups: DemandSignal[] = [];
    let outcome: string;
    if (await openWalkExists(tx, pageId)) {
      // The walk in progress owns the claim.
      outcome = "walk_open";
    } else {
      const stop = await currentWalkStop(tx, pageId);
      if (stop === null) {
        // The page's first read: this head is page one of the history walk.
        const short = rows.length < PAYOUT_REQUESTS_PAGE_SIZE;
        const reachedTotal = total !== null && PAYOUT_REQUESTS_PAGE_SIZE >= total;
        if (short || reachedTotal) {
          const walkStop = payoutWalkStopAt({ offset: 0, rowCount: rows.length, total });
          await writeSettledRequestsCoverage(tx, {
            pageId, now: input.now, stop: walkStop, observationId: input.observation.id, stoppedHere: true, total, floorMs,
            cursor: { offset: PAYOUT_REQUESTS_PAGE_SIZE, pages: 1 },
          });
          if (walkStop === "short_before_total") counters.short_before_total = 1;
          outcome = `walk_${walkStop}`;
        } else {
          followups.push(walkFollowup({ lastPageFirstRef: firstPayoutRef(rows), catchUp: null }, "first_walk"));
          await writeCoverage(tx, {
            pageId, now: input.now, scope: FANSLY_PAYOUTS_COVERAGE_SCOPES.requests, status: "in_progress", proof: "terminal_response",
            proofObservationId: input.observation.id, reasonCode: "head_captured", expectedCount: total,
            oldestCapturedAt: floorMs === null ? null : new Date(floorMs), cursor: { offset: PAYOUT_REQUESTS_PAGE_SIZE, pages: 1 },
          });
          outcome = "walk_started";
        }
      } else {
        const catchUp = payoutHeadGap({ previousHeadRefs: cursor.headRefs, previousTotal: cursor.walkTotal, headRows: rows, total });
        if (catchUp !== null) {
          followups.push(walkFollowup({ lastPageFirstRef: firstPayoutRef(rows), catchUp }, "head_gap"));
          await writeCoverage(tx, {
            pageId, now: input.now, scope: FANSLY_PAYOUTS_COVERAGE_SCOPES.requests, status: "in_progress", proof: "terminal_response",
            proofObservationId: input.observation.id, reasonCode: "catching_up", expectedCount: total,
            oldestCapturedAt: floorMs === null ? null : new Date(floorMs), cursor: { offset: PAYOUT_REQUESTS_PAGE_SIZE, pages: 1 },
          });
          counters.head_gap = 1;
          outcome = "catch_up";
        } else {
          // Restate the claim the history already has; nothing upgrades it.
          await writeSettledRequestsCoverage(tx, {
            pageId, now: input.now, stop, observationId: input.observation.id, stoppedHere: false, total, floorMs,
            cursor: { offset: 0, pages: 1 },
          });
          outcome = "head_read";
        }
      }
    }
    const next: DailyCursor = {
      step: 0,
      headRefs: payoutRefs(rows),
      walkTotal: total ?? cursor.walkTotal,
      unknownStatusCodes: [...cursor.unknownStatusCodes, ...unknown].sort((a, b) => a - b),
    };
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: outcome,
        cursor: next,
        proof: { rows: rows.length, total, outcome, observationId: input.observation.id },
      },
      followups,
      counters,
    };
  },

  async shadow(work, _request, ctx): Promise<ShadowResult> {
    const cursor = parseDailyCursor(work.cursor);
    return cursor.step === 0
      ? { work: { satisfiesRevision: false, nextDueAt: ctx.now, cursor: { ...cursor, step: 1 } }, followups: [] }
      : { work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: { ...cursor, step: 0 } }, followups: [] };
  },

  async replay(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
    return replayPayouts(observation, ctx);
  },

  async importLegacy(tx, page): Promise<LegacyImport> {
    const legacy = await tx.execute<{ state: unknown }>(sql`
      select state from page_sync_cursors where page_id = ${page.pageId} and stream = 'payouts'
    `);
    const state = parseFanslyPayoutsCursorState(legacy.rows[0]?.state ?? null);
    if (state === null) return { cursors: [], notes: { payouts: "none" } };
    const daily: DailyCursor = { step: 0, headRefs: state.headRefs, walkTotal: state.walkTotal, unknownStatusCodes: state.unknownStatusCodes };
    const cursors: LegacyImport["cursors"][number][] = [{ resource: "payouts.daily", subject: "", cursor: daily }];
    if (!state.walkDone && state.walkOffset > 0) {
      const walk: WalkCursor = {
        offset: state.walkOffset,
        lastRequestedOffset: state.lastRequestedOffset,
        lastPageFirstRef: state.lastPageFirstRef,
        pages: state.walkPages,
        catchUp: state.catchUp,
      };
      cursors.push({ resource: PAYOUTS_WALK_KEY, subject: "", cursor: walk });
    }
    return { cursors, notes: { payouts: state.walkDone ? "walk_done" : `walk_open:${state.walkOffset}` } };
  },
};

const walkModule: ResourceModule = {
  async plan(work): Promise<StepPlan> {
    const cursor = parseWalkCursor(work.cursor, work.params);
    // The same offset twice is a loop's first step: only a corrupted cursor
    // gets here (every apply advances it).
    if (cursor.lastRequestedOffset === cursor.offset) return { kind: "quarantine", reason: "payout_offset_repeat" };
    return { kind: "request", request: { spec: "payouts.requests", params: { offset: cursor.offset } } };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    assertValid(FANSLY_PAYOUTS_OBSERVATION_KINDS.payoutRequests, input.response);
    const pageId = input.pageId;
    const cursor = parseWalkCursor(input.work.cursor, input.work.params);
    const requestedOffset = intOrNull(recordOf(input.request.params).offset);
    if (requestedOffset !== cursor.offset) {
      throw new ApplyQuarantine("payout_cursor_mismatch", { requestedOffset, walkOffset: cursor.offset });
    }
    const rows = payoutRequestRows(input.response);
    const total = payoutRequestTotal(input.response);
    const floorMs = oldestCreatedAtMs(rows);
    const unknown = unknownStatuses(rows, []);
    const counters: Record<string, number> = unknown.length > 0 ? { payout_status_unknown: unknown.length } : {};
    const previousStop = await currentWalkStop(tx, pageId);
    const pageFirstRef = firstPayoutRef(rows);
    const pages = cursor.pages + 1;
    const settle = async (stop: FanslyPayoutsWalkStop | null, stoppedHere: boolean, nextOffset: number) => {
      await writeSettledRequestsCoverage(tx, {
        pageId, now: input.now, stop, observationId: input.observation.id, stoppedHere, total, floorMs,
        cursor: { offset: nextOffset, pages },
      });
      const receipt = { stop: stop ?? "exhausted", pages, total, observationId: input.observation.id };
      return {
        work: {
          satisfiesRevision: true,
          close: "done" as const,
          closeReason: stop ?? "exhausted",
          cursor: { ...cursor, offset: nextOffset, lastRequestedOffset: requestedOffset, lastPageFirstRef: pageFirstRef, pages, catchUp: null },
          proof: receipt,
        },
        followups: [],
        counters,
      };
    };

    // A page that begins where the previous one began is a server ignoring
    // `offset`: walking on would re-read page one.
    if (pageFirstRef !== null && pageFirstRef === cursor.lastPageFirstRef) {
      const stop = settleWalkStop(previousStop, "repeat_request");
      counters.offset_repeat = 1;
      return settle(stop, stop === "repeat_request", cursor.offset);
    }
    const advanced = advanceOffsetPage({ offset: cursor.offset, pageSize: PAYOUT_REQUESTS_PAGE_SIZE, rowCount: rows.length });
    const reachedTotal = total !== null && advanced.nextOffset >= total;
    const reachedEnd = advanced.done || reachedTotal;
    const endStop = reachedEnd ? payoutWalkStopAt({ offset: cursor.offset, rowCount: rows.length, total }) : null;
    // A catch-up that reaches the previous head read new rows, not the floor:
    // the stop stays as it was.
    const caughtUp = cursor.catchUp !== null && catchUpReached(cursor.catchUp, rows, advanced.nextOffset);
    if (reachedEnd || caughtUp) {
      const stop = endStop === null ? previousStop : settleWalkStop(previousStop, endStop);
      if (endStop === "short_before_total") counters.short_before_total = 1;
      return settle(stop, endStop !== null && stop === endStop, advanced.nextOffset);
    }
    if (pages >= REQUEST_WALK_MAX_PAGES) {
      counters.walk_capped = 1;
      return settle(settleWalkStop(previousStop, "page_cap"), true, advanced.nextOffset);
    }
    await writeCoverage(tx, {
      pageId, now: input.now, scope: FANSLY_PAYOUTS_COVERAGE_SCOPES.requests, status: "in_progress", proof: "terminal_response",
      proofObservationId: input.observation.id, reasonCode: cursor.catchUp === null ? "walking" : "catching_up", expectedCount: total,
      oldestCapturedAt: floorMs === null ? null : new Date(floorMs), cursor: { offset: advanced.nextOffset, pages },
    });
    return {
      work: {
        satisfiesRevision: false,
        nextDueAt: input.now,
        cursor: {
          offset: advanced.nextOffset,
          lastRequestedOffset: requestedOffset,
          lastPageFirstRef: pageFirstRef,
          pages,
          catchUp: cursor.catchUp,
        } satisfies WalkCursor,
      },
      followups: [],
      counters,
    };
  },

  async shadow(): Promise<ShadowResult> {
    // Only a live head starts a walk; a shadow walk (owner) is one page.
    return { work: { satisfiesRevision: true, close: "done", closeReason: "shadow" }, followups: [] };
  },
};

export function payoutsModule(variant: PayoutsVariant): ResourceModule {
  return variant === "daily" ? dailyModule : walkModule;
}

function methodRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((row): row is Record<string, unknown> => recordOf(row) === row);
  for (const value of Object.values(recordOf(payload))) {
    if (Array.isArray(value)) return value.filter((row): row is Record<string, unknown> => recordOf(row) === row);
  }
  return [];
}

/**
 * Replay of a legacy `payout_methods` / `payout_requests` observation: the
 * lane's predicate accepts the body, and every method / payout it served has
 * its projected row on the page.
 */
async function replayPayouts(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
  if (classifyPayoutResponse(observation.kind, observation.payload) === "invalid") {
    return { kind: "mismatch", reason: "contract_refused" };
  }
  const methods = observation.kind === FANSLY_PAYOUTS_OBSERVATION_KINDS.payoutMethods;
  const refs = [...new Set((methods ? methodRows(observation.payload) : payoutRequestRows(observation.payload))
    .map((row) => nonEmpty(row.id))
    .filter((id): id is string => id !== null))];
  if (refs.length === 0) return { kind: "match", detail: { served: 0 } };
  const stored = methods
    ? await ctx.db.execute<{ ref: string }>(sql`
      select method_ref as ref from page_payout_methods where page_id = ${ctx.pageId} and method_ref = any(${sql.param(refs)}::text[])
    `)
    : await ctx.db.execute<{ ref: string }>(sql`
      select payout_ref as ref from page_payout_requests where page_id = ${ctx.pageId} and payout_ref = any(${sql.param(refs)}::text[])
    `);
  const known = new Set(stored.rows.map((row) => row.ref));
  const missing = refs.filter((ref) => !known.has(ref));
  return missing.length === 0
    ? { kind: "match", detail: { served: refs.length } }
    : { kind: "mismatch", reason: "rows_missing", detail: { served: refs.length, missing: missing.length } };
}
