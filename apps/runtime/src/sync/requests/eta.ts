import type { HistoryDepth, HistoryThreadFacts, SyncRouteUse } from "@agency_hub_core/db";
import { FANSLY_MESSAGES_PAGE_LIMIT } from "@agency_hub_core/fansly";
import { fanslySnowflakeToDate } from "@agency_hub_core/shared";

import { JITTER_MAX } from "../engine/pacer.ts";
import { classOf, CYCLE, type WorkClass } from "../engine/scheduler.ts";
import { familyOfRoute, routeOfEngineOperation, type FanslyRoute } from "../fansly/routes.ts";

// Estimates of a history request (plan §4.3, design §7.2). The inputs are the
// thread's columns only — the proven chain (0231), the legacy stored window
// and the chat's creation instant from its snowflake — never a per-message
// query: 1 000 fans must be estimated inside the ≤ 3 s intake (thread 5035
// alone holds 14 942 messages).
//
// Always two numbers: a lower bound ("не меньше", from what the hub already
// knows exists) and an estimate (the unknown part of the chat at the density
// of the stored window, labelled as an estimate). No upper bound exists for an
// unknown depth; `latest N` has one with full pages.
//
// The time a read takes (step 3b ruling 11, owner decision №24) is set by the
// tightest of three budgets a history read draws on: the page's slots (one
// send per pause S × (1 + u)), its route's (`/message`, 15/min — lower after
// a 429 halved it) and that route's family (messaging: the list, a chat's
// detail and `/message`, 15/min combined). Each is shared with what the
// urgent and planned classes send on it — measured on the journal of the
// last 15 minutes — and the scheduler's cycle shares each budget by its
// turns, a class that wants less leaving the rest (`requestsCapacity`). No
// share is raised to a floor: an observed use is never overruled. A hold — the
// page's, or the route's own after a 429 — stops the reads for its known
// span; it is shown beside the estimate, never folded into its rate.

/** Every history read is one `/message` page: the route whose budgets pace
 *  it (the `dm-messages.history` key's only operation, pinned by
 *  tests/sync-history-eta.test.ts). */
export const HISTORY_READ_ROUTE: FanslyRoute = "messages.page";
/** Messages per `/message` page (every engine read uses limit 25). */
export const HISTORY_READ_PAGE_SIZE = FANSLY_MESSAGES_PAGE_LIMIT;
/** The mean pause is S × (1 + u), u uniform in [0, JITTER_MAX); the ≈ 0.3 s
 *  p50 response lies inside the pause. */
export const ETA_MEAN_PAUSE_FACTOR = 1 + JITTER_MAX / 2;
/** The window the other classes' use of the page's slots and budgets is
 *  measured over. */
export const ETA_USE_WINDOW_MS = 15 * 60_000;
/** The stored window's span is at least an hour (a burst of messages within
 *  one minute is not a density of thousands an hour). */
export const ETA_MIN_DENSITY_SPAN_MS = 3_600_000;

const DECIMAL = /^[0-9]{1,30}$/;

function snowflakeAt(id: string | null): Date | null {
  if (id === null || !DECIMAL.test(id)) return null;
  return fanslySnowflakeToDate(id);
}

/** The thread facts an item's estimate reads (design §7.2 inputs). */
export interface ItemEtaFacts {
  complete: boolean;
  /** Messages in the proven chain. */
  chainCount: number;
  /** `created_at` of the chain's oldest message. */
  chainOldestAt: Date | null;
  storedCount: number;
  storedNewestAt: Date | null;
  storedOldestAt: Date | null;
  /** When the chat was created (its group id's snowflake). */
  chatStartAt: Date | null;
}

export function itemEtaFacts(thread: Pick<HistoryThreadFacts,
  "historyState" | "historyProof" | "contiguousCount" | "contiguousOldestAt" | "storedMessageCount"
  | "newestStoredMessageId" | "oldestStoredMessageId" | "groupId">): ItemEtaFacts {
  return {
    complete: thread.historyState === "complete" && thread.historyProof === "empty_page",
    chainCount: thread.contiguousCount,
    chainOldestAt: thread.contiguousOldestAt,
    storedCount: thread.storedMessageCount,
    storedNewestAt: snowflakeAt(thread.newestStoredMessageId),
    storedOldestAt: snowflakeAt(thread.oldestStoredMessageId),
    chatStartAt: snowflakeAt(thread.groupId),
  };
}

export interface ItemEtaInput {
  depth: HistoryDepth;
  /** The anchor is fixed: no head read is needed first. */
  anchored: boolean;
  /** Chain messages counted for `latest N` from the anchor (0 without one). */
  belowAnchor: number;
  facts: ItemEtaFacts;
  now: Date;
}

export interface ItemReadsEstimate {
  /** Reads at least needed ("не меньше"). */
  readsMin: number;
  /** Reads by the estimate; null when the stored window is too small for a
   *  density (fewer than 2 messages) and no upper bound applies. */
  readsEstimate: number | null;
  /** `latest N` only: the bound with full pages (+1 end check). */
  readsMax: number | null;
}

const NONE: ItemReadsEstimate = { readsMin: 0, readsEstimate: 0, readsMax: null };

function minDate(...dates: Array<Date | null>): Date | null {
  let best: Date | null = null;
  for (const date of dates) {
    if (date !== null && (best === null || date.getTime() < best.getTime())) best = date;
  }
  return best;
}

/**
 * Reads one fan still needs (design §7.2), from the thread's columns:
 *
 *   head      = anchored ? 0 : 1          the head read fixes the anchor
 *   unproven  = max(0, stored − chain)    stored but not proven: read again (§4.2 p.6)
 *   density   = stored / max(1 h, newest − oldest stored)
 *   unknown   = (oldest of chain and stored, or now) − chat start
 *   all:      readsMin = max(head, ⌈unproven/25⌉) + 1        (+1: the empty page that proves the start)
 *             readsEst = readsMin + ⌈unknown × density / 25⌉
 *   latest N: need     = max(0, N − belowAnchor)
 *             readsMin = max(head, ⌈min(need, unproven)/25⌉, 1)
 *             readsMax = head + ⌈need/25⌉ + 1
 *             readsEst = min(readsMax, readsMin + ⌈unknown × density / 25⌉)
 *
 * The head read is the first page of the walk, so it is not added on top of
 * the unproven pages (it reads the newest 25 of them): `max(head, …)`, which
 * keeps `readsMin` a true lower bound when no chain exists yet.
 */
export function estimateItemReads(input: ItemEtaInput): ItemReadsEstimate {
  const { facts, depth } = input;
  if (facts.complete) return NONE;
  const K = HISTORY_READ_PAGE_SIZE;
  const head = input.anchored ? 0 : 1;
  const unproven = Math.max(0, facts.storedCount - facts.chainCount);
  const density = facts.storedCount >= 2 && facts.storedNewestAt !== null && facts.storedOldestAt !== null
    ? facts.storedCount / Math.max(ETA_MIN_DENSITY_SPAN_MS, facts.storedNewestAt.getTime() - facts.storedOldestAt.getTime())
    : null;
  const unknownReads = (spanEnd: Date | null): number | null => {
    if (density === null) return null;
    const start = facts.chatStartAt;
    if (start === null || spanEnd === null) return 0;
    return Math.ceil((Math.max(0, spanEnd.getTime() - start.getTime()) * density) / K);
  };
  const knownOldest = minDate(facts.chainOldestAt, facts.storedOldestAt) ?? input.now;
  switch (depth.kind) {
    case "all": {
      const readsMin = Math.max(head, Math.ceil(unproven / K)) + 1;
      const unknown = unknownReads(knownOldest);
      return { readsMin, readsEstimate: unknown === null ? null : readsMin + unknown, readsMax: null };
    }
    case "latest": {
      const need = Math.max(0, depth.count - (input.anchored ? input.belowAnchor : 0));
      if (input.anchored && need === 0) return NONE;
      const readsMin = Math.max(head, Math.ceil(Math.min(need, unproven) / K), 1);
      const readsMax = head + Math.ceil(need / K) + 1;
      const unknown = unknownReads(knownOldest);
      return {
        readsMin,
        readsEstimate: unknown === null ? readsMax : Math.min(readsMax, readsMin + unknown),
        readsMax,
      };
    }
    case "before_boundary": {
      // The legacy wrapper's window: from the chain (or the newest stored
      // message) down to the boundary.
      const readsMin = Math.max(head, 1);
      const boundary = depth.at;
      if (density === null || boundary === null) return { readsMin, readsEstimate: null, readsMax: null };
      const spanEnd = facts.chainOldestAt ?? facts.storedNewestAt ?? input.now;
      const between = Math.max(0, spanEnd.getTime() - boundary.getTime());
      return { readsMin, readsEstimate: readsMin + Math.ceil((between * density) / K), readsMax: null };
    }
  }
}

// ── the rate of a request (step 3b ruling 11) ─────────────────────────────────

/** A class's sends a minute. */
export type ClassRates = Readonly<Record<WorkClass, number>>;

/** What the page's classes sent a minute over the window on each budget a
 *  history read draws on. */
export interface BudgetUse {
  /** Every send: the page's slots. */
  page: ClassRates;
  /** Sends on the history read's route. */
  route: ClassRates;
  /** Sends on that route's family (the route included). */
  family: ClassRates;
}

const NO_RATES: ClassRates = { urgent: 0, requests: 0, planned: 0 };

/**
 * The window's journal (`readRouteUse`) as rates a minute. A send of an
 * operation this build cannot place counts on every budget, as the route
 * clocks count it (an unknown send consumes budget).
 */
export function budgetUseOf(rows: readonly SyncRouteUse[], windowMs: number): BudgetUse {
  const minutes = Math.max(1, windowMs) / 60_000;
  const page = { ...NO_RATES };
  const route = { ...NO_RATES };
  const family = { ...NO_RATES };
  const historyFamily = familyOfRoute(HISTORY_READ_ROUTE);
  for (const row of rows) {
    const rate = row.sends / minutes;
    const sent = routeOfEngineOperation(row.operation);
    page[row.class] += rate;
    if (sent === null || sent === HISTORY_READ_ROUTE) route[row.class] += rate;
    if (sent === null || (historyFamily !== null && familyOfRoute(sent) === historyFamily)) family[row.class] += rate;
  }
  return { page, route, family };
}

/** Each class's turns in the scheduler's cycle (U R U R U R U R U P: 5, 4, 1). */
export const CYCLE_TURNS: Readonly<Record<WorkClass, number>> = (() => {
  const turns: Record<WorkClass, number> = { urgent: 0, requests: 0, planned: 0 };
  for (const slot of CYCLE) turns[classOf(slot)] += 1;
  return turns;
})();

/** The budget that sets a request's rate. */
export type EtaLimit = "page" | "route" | "family";

export interface RequestsCapacityInput {
  /** S, the owner's pause. */
  settingMs: number;
  /** The history read route's rate on the page: the table's `current`, or
   *  the page's slowdown after a 429 when that is lower. */
  routePerMin: number;
  /** Its family's rate (null: the route has none). */
  familyPerMin: number | null;
  use: BudgetUse;
}

export interface RequestsCapacity {
  /** History reads a minute of the requests class (all requests together). */
  perMin: number;
  /** Its share of the page's slots, 0..1. */
  slotShare: number;
  limitedBy: EtaLimit;
}

/**
 * What the requests class keeps of one budget of `capacity` sends a minute
 * beside the other classes. The cycle is a weighted round robin that skips a
 * class with nothing to send: each class gets its turns' part of the budget
 * (`CYCLE_TURNS`) unless it wants less, and what it leaves is shared by the
 * same weights among the rest (water-filling). The requests class wants all
 * it can get; the urgent and planned classes want what they sent over the
 * window. Nothing is raised to a floor: a class that took little leaves the
 * rest, and only a class that wants more than its turns is held to them.
 */
export function keptByRequests(capacity: number, use: ClassRates): number {
  let remaining = capacity;
  let others = (["urgent", "planned"] as const).filter((workClass) => use[workClass] > 0);
  for (;;) {
    const turns = CYCLE_TURNS.requests + others.reduce((sum, workClass) => sum + CYCLE_TURNS[workClass], 0);
    const perTurn = remaining / turns;
    const content = others.filter((workClass) => use[workClass] <= CYCLE_TURNS[workClass] * perTurn);
    if (content.length === 0) return CYCLE_TURNS.requests * perTurn;
    for (const workClass of content) remaining -= use[workClass];
    others = others.filter((workClass) => !content.includes(workClass));
  }
}

/**
 * The reads a minute the requests class gets on the page now (step 3b
 * ruling 11) — the tightest of the three budgets a history read draws on:
 *
 *   C_page   = 60 000 / (S × 1.1)      the page's slots at the mean pause
 *   C_route  = the route's rate         (a slowdown after a 429 lowers it)
 *   C_family = the family's rate
 *   R_x      = keptByRequests(C_x, what the classes sent on x a minute)
 *   perMin   = min(R_page, R_route, R_family)
 *
 * With the budgets as shipped and S = 2.5 s, a page whose other classes take
 * ≈ 2 reads a minute of the messaging family gives history ≈ 13/min, ≈ 800
 * reads an hour (owner decision №24). Holds are not in it: a held page or
 * route reads nothing until the hold ends.
 */
export function requestsCapacity(input: RequestsCapacityInput): RequestsCapacity {
  const pageSlots = 60_000 / (input.settingMs * ETA_MEAN_PAUSE_FACTOR);
  const page = keptByRequests(pageSlots, input.use.page);
  const route = keptByRequests(input.routePerMin, input.use.route);
  const family = input.familyPerMin === null ? Number.POSITIVE_INFINITY : keptByRequests(input.familyPerMin, input.use.family);
  const perMin = Math.min(page, route, family);
  return {
    perMin,
    slotShare: page / pageSlots,
    limitedBy: perMin === page ? "page" : perMin === family ? "family" : "route",
  };
}

export interface RequestEta {
  remainingMin: number;
  remainingEstimate: number | null;
  /** One read of this request every … ms: the class's rate shared round
   *  robin between the page's k requests. */
  perReadMs: number;
  /** The requests class's share of the page's slots. */
  share: number;
  limitedBy: EtaLimit;
  /** Open requests of the page sharing the class (round robin), ≥ 1. */
  k: number;
  etaMinMs: number;
  etaEstimateMs: number | null;
  /** Reads an hour this request gets while it is not held. */
  ratePerHour: number;
  /** "Свежие сообщения всех фанов": the first round's head reads. */
  firstRoundMs: number;
}

/**
 * A request's remaining reads and time (design §7.2): the sum over its open
 * fans, at the class's rate (`requestsCapacity`) divided between the page's
 * k requests.
 */
export function estimateRequest(input: {
  items: readonly ItemReadsEstimate[];
  unanchoredItems: number;
  capacity: RequestsCapacity;
  k: number;
}): RequestEta {
  const remainingMin = input.items.reduce((sum, item) => sum + item.readsMin, 0);
  const remainingEstimate = input.items.some((item) => item.readsEstimate === null)
    ? null
    : input.items.reduce((sum, item) => sum + (item.readsEstimate ?? 0), 0);
  const k = Math.max(1, input.k);
  const perReadMs = (60_000 * k) / input.capacity.perMin;
  return {
    remainingMin,
    remainingEstimate,
    perReadMs,
    share: input.capacity.slotShare,
    limitedBy: input.capacity.limitedBy,
    k,
    etaMinMs: Math.round(remainingMin * perReadMs),
    etaEstimateMs: remainingEstimate === null ? null : Math.round(remainingEstimate * perReadMs),
    ratePerHour: Math.round((3_600_000 / perReadMs) * 10) / 10,
    firstRoundMs: Math.round(input.unanchoredItems * perReadMs),
  };
}
