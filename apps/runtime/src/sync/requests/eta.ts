import type { HistoryDepth, HistoryThreadFacts } from "@agency_hub_core/db";
import { FANSLY_MESSAGES_PAGE_LIMIT } from "@agency_hub_core/fansly";
import { fanslySnowflakeToDate } from "@agency_hub_core/shared";

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

/** Messages per `/message` page (every engine read uses limit 25). */
export const HISTORY_READ_PAGE_SIZE = FANSLY_MESSAGES_PAGE_LIMIT;
/** The mean pause is S × (1 + u), u uniform in [0, 0.2); the ≈ 0.3 s p50
 *  response lies inside the pause. */
export const ETA_MEAN_PAUSE_FACTOR = 1.1;
/** The window the requests class's observed share is measured over. */
export const ETA_SHARE_WINDOW_MS = 15 * 60_000;
/** Below this many sends in the window the share is the default. */
export const ETA_SHARE_MIN_SAMPLES = 20;
export const ETA_DEFAULT_SHARE = 0.8;
/** The requests class's floor under full contention: 4 of 10 slots (§3.4). */
export const ETA_MIN_SHARE = 0.4;
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

/** Sends of the page by class over the share window. */
export interface ClassSends {
  urgent: number;
  requests: number;
  planned: number;
}

/**
 * The share of the page's slots the requests class gets (design §7.2): 1 when
 * no other class has runnable work now; the default 0.8 below 20 sends in the
 * window; otherwise the observed requests share of the window, never below
 * the class's guaranteed 40 % (an observed share can only understate it — the
 * class may have had nothing to run for part of the window).
 */
export function requestsClassShare(input: { sends: ClassSends; otherClassesRunnable: boolean }): number {
  if (!input.otherClassesRunnable) return 1;
  const total = input.sends.urgent + input.sends.requests + input.sends.planned;
  if (total < ETA_SHARE_MIN_SAMPLES) return ETA_DEFAULT_SHARE;
  return Math.min(1, Math.max(ETA_MIN_SHARE, input.sends.requests / total));
}

export interface RequestEta {
  remainingMin: number;
  remainingEstimate: number | null;
  /** S × 1.1: the mean pause between two sends of the page. */
  meanPauseMs: number;
  share: number;
  /** Open requests of the page sharing the class (round robin), ≥ 1. */
  k: number;
  etaMinMs: number;
  etaEstimateMs: number | null;
  /** Reads an hour this request gets now. */
  ratePerHour: number;
  /** "Свежие сообщения всех фанов": the first round's head reads. */
  firstRoundMs: number;
}

/**
 * A request's remaining reads and time (design §7.2): the sum over its open
 * fans, at the mean pause, divided between the k requests of the page and
 * the class's share.
 */
export function estimateRequest(input: {
  items: readonly ItemReadsEstimate[];
  unanchoredItems: number;
  settingMs: number;
  share: number;
  k: number;
}): RequestEta {
  const remainingMin = input.items.reduce((sum, item) => sum + item.readsMin, 0);
  const remainingEstimate = input.items.some((item) => item.readsEstimate === null)
    ? null
    : input.items.reduce((sum, item) => sum + (item.readsEstimate ?? 0), 0);
  const meanPauseMs = input.settingMs * ETA_MEAN_PAUSE_FACTOR;
  const k = Math.max(1, input.k);
  const share = Math.min(1, Math.max(ETA_MIN_SHARE, input.share));
  const perRead = (meanPauseMs * k) / share;
  return {
    remainingMin,
    remainingEstimate,
    meanPauseMs,
    share,
    k,
    etaMinMs: Math.round(remainingMin * perRead),
    etaEstimateMs: remainingEstimate === null ? null : Math.round(remainingEstimate * perRead),
    ratePerHour: Math.round((3_600_000 / perRead) * 10) / 10,
    firstRoundMs: Math.round(input.unanchoredItems * perRead),
  };
}
