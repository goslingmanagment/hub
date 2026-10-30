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
// first time (Fansly serves a long span in one answer), then over its last 14
// days every day, so late corrections land. The links are the ones the
// latest `/trackinglinks` snapshot names (stats.daily, `page_promo_links`).
// Each answer is journaled first; the apply writes the typed rows.

const DAY_MS = 86_400_000;
/** The daily re-read: Fansly corrects recent days for a while. */
const RECENT_DAYS = 14;
/** A link with no known creation is read this far back the first time. */
const FALLBACK_HISTORY_DAYS = 730;

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
}

interface Cursor {
  sweep: Sweep | null;
  /** Links whose whole history has been read. */
  historyDone: string[];
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
  return { links, index, half: record.half === 1 ? 1 : 0, beforeMs };
}

function parseCursor(value: unknown): Cursor {
  const record = recordOf(value);
  return {
    sweep: parseSweep(record.sweep),
    historyDone: Array.isArray(record.historyDone) ? record.historyDone.filter((ref): ref is string => typeof ref === "string") : [],
  };
}

function requestOf(sweep: Sweep, historyDone: readonly string[]): RequestPlan {
  const link = sweep.links[sweep.index]!;
  return {
    spec: sweep.half === 0 ? "trackinglinks.stats" : "trackinglinks.revenuestats",
    params: { trackingLinkId: link.ref, beforeMs: sweep.beforeMs, afterMs: link.afterMs },
    step: { sweep, historyDone },
  } as RequestPlan;
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

function statsRows(response: unknown): TrackingLinkDayRow[] | null {
  const rows = rowsOf(response);
  if (rows === null) return null;
  return rows.flatMap((row) => {
    const day = dayOf(row);
    return day === null ? [] : [{ day, clicks: count(row.clicks), claims: count(row.claims), follows: count(row.follows), subscriptions: count(row.subscriptions) }];
  });
}

function revenueRows(response: unknown): TrackingLinkRevenueDayRow[] | null {
  const rows = rowsOf(response);
  if (rows === null) return null;
  return rows.flatMap((row) => {
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
    if (cursor.sweep !== null) return { kind: "request", request: requestOf(cursor.sweep, cursor.historyDone) };
    const now = ctx.now.getTime();
    const links = await listPageTrackingLinkRefs(ctx.db, ctx.pageId);
    if (links.length === 0) return { kind: "done", reason: "no_tracking_links", cursor: cursor satisfies Cursor };
    const done = new Set(cursor.historyDone);
    const sweep: Sweep = {
      links: links.map((link) => ({
        ref: link.linkRef,
        afterMs: done.has(link.linkRef)
          ? now - RECENT_DAYS * DAY_MS
          : Math.max(0, (link.createdAt?.getTime() ?? now - FALLBACK_HISTORY_DAYS * DAY_MS) - DAY_MS),
      })),
      index: 0,
      half: 0,
      beforeMs: now,
    };
    return { kind: "request", request: requestOf(sweep, cursor.historyDone) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const step = recordOf(input.request.step);
    const sweep = parseSweep(step.sweep);
    const historyDone = parseCursor({ historyDone: step.historyDone }).historyDone;
    if (sweep === null) throw new ApplyQuarantine("tracking_links_step_missing", { spec: input.request.spec });
    const link = sweep.links[sweep.index]!;
    const lineage = { pageId: input.pageId, observationId: input.observation.id, capturedAt: input.observation.receivedAt };
    if (sweep.half === 0) {
      const rows = statsRows(input.response);
      if (rows === null) throw new ApplyQuarantine("tracking_link_stats_not_a_list", { link: link.ref });
      await upsertTrackingLinkDays(tx, lineage, link.ref, rows);
    } else {
      const rows = revenueRows(input.response);
      if (rows === null) throw new ApplyQuarantine("tracking_link_revenue_not_a_list", { link: link.ref });
      await upsertTrackingLinkRevenueDays(tx, lineage, link.ref, rows);
    }
    if (sweep.half === 0) {
      return { work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { sweep: { ...sweep, half: 1 }, historyDone } }, followups: [] };
    }
    const nowDone = historyDone.includes(link.ref) ? historyDone : [...historyDone, link.ref];
    const next = sweep.index + 1;
    if (next < sweep.links.length) {
      return { work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { sweep: { ...sweep, index: next, half: 0 }, historyDone: nowDone } }, followups: [] };
    }
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: "tracking_links_read",
        cursor: { sweep: null, historyDone: nowDone },
        result: { links: sweep.links.length, completedAt: input.now.toISOString() },
      },
      followups: [],
      counters: { tracking_link_sweeps: 1 },
    };
  },
};
