import {
  listPageTrackingLinkRefs,
  upsertTrackingLinkDays,
  upsertTrackingLinkRevenueDays,
  type TrackingLinkDayRow,
  type TrackingLinkRevenueDayRow,
} from "@agency_hub_core/db";
import { millsFromInteger } from "@agency_hub_core/shared";

import { ApplyQuarantine } from "../../engine/commit.ts";
import type { ApplyInput, ApplyResult, RequestPlan, ResourceModule, StepPlan } from "../../engine/resource.ts";

// `tracking-links.daily` (0339): each live tracking link's days, as its stats
// screen shows them — `/trackinglinks/stats` (clicks, claims, follows,
// subscriptions a day) and `/trackinglinks/revenuestats` (revenue a day and
// transaction type), one request a step. A link is read from its creation the
// first time, then over its last 14 days every day, so late corrections land.
// Fansly serves at most 1000 rows an answer, the newest first (a busy link's
// revenue is a row a day and type), so a cut answer is followed by one that
// ends with its oldest day. The links are the ones the latest `/trackinglinks`
// snapshot names (stats.daily, `page_promo_links`). Each answer is journaled
// first; the apply writes the typed rows.

const DAY_MS = 86_400_000;
/** The daily re-read: Fansly corrects recent days for a while. */
const RECENT_DAYS = 14;
/** A link with no known creation is read this far back the first time. */
const FALLBACK_HISTORY_DAYS = 730;
/** The most rows Fansly serves in one answer: a full one was cut. */
export const SERVED_ROWS_MAX = 1000;

interface SweepLink {
  ref: string;
  afterMs: number;
}

interface Sweep {
  links: SweepLink[];
  index: number;
  /** 0: the counters; 1: the revenue. */
  half: 0 | 1;
  beforeMs: number;
  /** The end of the current link's next read after a cut answer; null: `beforeMs`. */
  untilMs: number | null;
}

interface Cursor {
  sweep: Sweep | null;
  /** Links whose whole history has been read. */
  historyRead: string[];
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function int(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function parseSweep(value: unknown): Sweep | null {
  const record = recordOf(value);
  const links = Array.isArray(record.links)
    ? record.links.map(recordOf).flatMap((link) => (typeof link.ref === "string" && int(link.afterMs) !== null ? [{ ref: link.ref, afterMs: int(link.afterMs)! }] : []))
    : [];
  const index = int(record.index);
  const beforeMs = int(record.beforeMs);
  if (links.length === 0 || index === null || index < 0 || index >= links.length || beforeMs === null) return null;
  return { links, index, half: record.half === 1 ? 1 : 0, beforeMs, untilMs: int(record.untilMs) };
}

function parseCursor(value: unknown): Cursor {
  const record = recordOf(value);
  return {
    sweep: parseSweep(record.sweep),
    historyRead: Array.isArray(record.historyRead) ? record.historyRead.filter((ref): ref is string => typeof ref === "string") : [],
  };
}

function requestOf(sweep: Sweep, historyRead: readonly string[]): RequestPlan {
  const link = sweep.links[sweep.index]!;
  return {
    spec: sweep.half === 0 ? "trackinglinks.stats" : "trackinglinks.revenuestats",
    params: { trackingLinkId: link.ref, beforeMs: sweep.untilMs ?? sweep.beforeMs, afterMs: link.afterMs },
    step: { sweep, historyRead },
  } as RequestPlan;
}

/** The end of the next read of the same link and half, or null: the answer
 *  was whole. A cut answer kept the newest rows, so the next read ends with
 *  the oldest day served: that day again whole, since the cut may split it. */
export function nextUntilMs(served: readonly Record<string, unknown>[], untilMs: number, afterMs: number): number | null {
  if (served.length < SERVED_ROWS_MAX) return null;
  const days = served.map((row) => int(row.timestamp)).filter((ms): ms is number => ms !== null);
  if (days.length === 0) return null;
  const oldest = Math.min(...days);
  const next = oldest + DAY_MS;
  return oldest > afterMs && next < untilMs ? next : null;
}

/** The UTC day of a served row: its `timestamp` (the day's start, ms). */
function dayOf(row: Record<string, unknown>): string | null {
  const ms = int(row.timestamp);
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}

function count(value: unknown): number | null {
  const n = int(value);
  return n === null || n < 0 ? null : n;
}

function rowsOf(response: unknown): Record<string, unknown>[] | null {
  return Array.isArray(response) ? response.map(recordOf) : null;
}

function statsRows(served: readonly Record<string, unknown>[]): TrackingLinkDayRow[] {
  return served.flatMap((row) => {
    const day = dayOf(row);
    return day === null ? [] : [{ day, clicks: count(row.clicks), claims: count(row.claims), follows: count(row.follows), subscriptions: count(row.subscriptions) }];
  });
}

function revenueRows(served: readonly Record<string, unknown>[]): TrackingLinkRevenueDayRow[] {
  return served.flatMap((row) => {
    const day = dayOf(row);
    const type = int(row.type);
    if (day === null || type === null) return [];
    const gross = int(row.totalGross);
    const net = int(row.totalNet);
    return [{ day, revenueType: type, grossMills: gross === null ? null : millsFromInteger(gross), netMills: net === null ? null : millsFromInteger(net) }];
  });
}

export const trackingLinksModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseCursor(work.cursor);
    if (cursor.sweep !== null) return { kind: "request", request: requestOf(cursor.sweep, cursor.historyRead) };
    const now = ctx.now.getTime();
    const links = await listPageTrackingLinkRefs(ctx.db, ctx.pageId);
    if (links.length === 0) return { kind: "done", reason: "no_tracking_links", cursor: cursor satisfies Cursor };
    const read = new Set(cursor.historyRead);
    const sweep: Sweep = {
      links: links.map((link) => ({
        ref: link.linkRef,
        afterMs: read.has(link.linkRef)
          ? now - RECENT_DAYS * DAY_MS
          : Math.max(0, (link.createdAt?.getTime() ?? now - FALLBACK_HISTORY_DAYS * DAY_MS) - DAY_MS),
      })),
      index: 0,
      half: 0,
      beforeMs: now,
      untilMs: null,
    };
    return { kind: "request", request: requestOf(sweep, cursor.historyRead) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const step = recordOf(input.request.step);
    const sweep = parseSweep(step.sweep);
    const historyRead = parseCursor({ historyRead: step.historyRead }).historyRead;
    if (sweep === null) throw new ApplyQuarantine("tracking_links_step_missing", { spec: input.request.spec });
    const link = sweep.links[sweep.index]!;
    const served = rowsOf(input.response);
    if (served === null) {
      throw new ApplyQuarantine(sweep.half === 0 ? "tracking_link_stats_not_a_list" : "tracking_link_revenue_not_a_list", { link: link.ref });
    }
    const lineage = { pageId: input.pageId, observationId: input.observation.id, capturedAt: input.observation.receivedAt };
    if (sweep.half === 0) await upsertTrackingLinkDays(tx, lineage, link.ref, statsRows(served));
    else await upsertTrackingLinkRevenueDays(tx, lineage, link.ref, revenueRows(served));
    const untilMs = nextUntilMs(served, sweep.untilMs ?? sweep.beforeMs, link.afterMs);
    if (untilMs !== null) {
      return { work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { sweep: { ...sweep, untilMs }, historyRead } }, followups: [] };
    }
    if (sweep.half === 0) {
      return { work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { sweep: { ...sweep, half: 1, untilMs: null }, historyRead } }, followups: [] };
    }
    const nowRead = historyRead.includes(link.ref) ? historyRead : [...historyRead, link.ref];
    const next = sweep.index + 1;
    if (next < sweep.links.length) {
      return { work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { sweep: { ...sweep, index: next, half: 0, untilMs: null }, historyRead: nowRead } }, followups: [] };
    }
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: "tracking_links_read",
        cursor: { sweep: null, historyRead: nowRead },
        result: { links: sweep.links.length, completedAt: input.now.toISOString() },
      },
      followups: [],
      counters: { tracking_link_sweeps: 1 },
    };
  },
};
