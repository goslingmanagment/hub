import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { SyncRouteSend } from "@agency_hub_core/db";

import {
  ROUTE_HOLD_JITTER_MAX,
  ROUTE_HOLD_LADDER_MS,
  ROUTE_RAISE_STEP_PER_MIN,
  ROUTE_SLOWDOWN_FLOOR_SHARE,
  routeHoldAfter,
  routeHoldUntil,
  routeRaise,
  routeSlowed,
  type RouteHoldInput,
} from "../apps/runtime/src/sync/engine/route-holds.ts";
import {
  EMPTY_ROUTE_STATE,
  RouteClocks,
  routeStateOfHolds,
  type RouteState,
  type RouteStateEntry,
} from "../apps/runtime/src/sync/engine/route-policy.ts";
import {
  DEFAULT_ROUTE_BUDGET,
  FAMILY_BUDGETS,
  FANSLY_ROUTE_FAMILIES,
  ROUTE_BUDGETS,
  routeBudget,
  routePolicyVersion,
  type FanslyRoute,
} from "../apps/runtime/src/sync/fansly/routes.ts";
import { SYNC_ROUTE_RAISE_AUDIT_EVENT } from "../apps/runtime/src/sync/route-raise.ts";
import { routeHoldRows } from "./helpers/sync-holds.ts";

// Route holds and slowdowns (step 3b ruling 2 as amended by A2; owner
// decisions №14, №22, D3): a 429 holds only its route — Retry-After to the
// letter, else 5 → 10 → … → 300 s + 0–20 % jitter — and halves the
// page+route's rate (≥ ⅛ ceiling) until a deliberate raise of at most
// +1/min, a compare-and-set on the revision.

const NOW = new Date("2026-10-03T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const HOUR_MS = 3_600_000;

function hold(overrides: Partial<RouteHoldInput> = {}): RouteHoldInput {
  return {
    route: "messages.page",
    entry: null,
    now: NOW,
    httpStatus: 429,
    retryAfterMs: null,
    attemptId: 1,
    jitter: () => 0,
    ...overrides,
  };
}

/** `n` 429s of one route, each after the previous hold ran out. */
function climb(route: FanslyRoute, n: number, jitter = 0): Array<{ holdMs: number; entry: RouteStateEntry }> {
  const steps: Array<{ holdMs: number; entry: RouteStateEntry }> = [];
  let entry: RouteStateEntry | null = null;
  let now = NOW;
  for (let i = 0; i < n; i += 1) {
    const next = routeHoldAfter(hold({ route, entry, now, attemptId: i + 1, jitter: () => jitter }));
    if (next === null) throw new Error("no hold");
    steps.push({ holdMs: next.holdUntil.getTime() - now.getTime(), entry: next.entry });
    expect(next.expectRevision).toBe(entry?.revision ?? 0);
    entry = next.entry;
    now = new Date(next.holdUntil.getTime() + 60_000);
  }
  return steps;
}

describe("route holds: a 429 without Retry-After", () => {
  it("climbs owner decision №14's ladder by the 429s of one slowdown: 5 → 10 → 20 → 40 → 80 → 160 → 300 s, then stays", () => {
    expect(ROUTE_HOLD_LADDER_MS).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000]);
    const steps = climb("messages.page", 9);
    expect(steps.map((step) => step.holdMs / 1_000)).toEqual([5, 10, 20, 40, 80, 160, 300, 300, 300]);
    expect(steps.map((step) => step.entry.ladderStep)).toEqual([1, 2, 3, 4, 5, 6, 6, 6, 6]);
    expect(steps.map((step) => step.entry.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("stretches a step by 0–20 % jitter, never shortens it", () => {
    expect(ROUTE_HOLD_JITTER_MAX).toBe(0.2);
    expect(climb("messages.page", 1, 0.5)[0]!.holdMs).toBe(5_500);
    expect(climb("messages.page", 1, 0.999_999)[0]!.holdMs).toBe(6_000);
    expect(climb("messages.page", 3, 1)[2]!.holdMs).toBe(24_000);
  });

  it("halves the page+route's rate at each 429, never below ⅛ of the route's ceiling", () => {
    expect(ROUTE_SLOWDOWN_FLOOR_SHARE).toBe(1 / 8);
    expect(climb("messages.page", 5).map((step) => step.entry.effectivePerMin)).toEqual([7.5, 3.75, 1.875, 1.875, 1.875]);
    // The list from its 12/min; the media statistics from their current 5/min
    // down to ⅛ of their 12/min ceiling.
    expect(climb("messaging.groups", 4).map((step) => step.entry.effectivePerMin)).toEqual([6, 3, 1.5, 1.5]);
    expect(climb("media.offer_stats", 3).map((step) => step.entry.effectivePerMin)).toEqual([2.5, 1.5, 1.5]);
    for (const step of climb("media.offer_stats", 2)) {
      expect(step.entry.policyVersion).toBe(routePolicyVersion("media.offer_stats"));
    }
  });

  it("records the 429: the attempt and the instant; the same attempt is written once", () => {
    const first = routeHoldAfter(hold({ attemptId: 42 }))!;
    expect(first.entry).toMatchObject({ last429AttemptId: 42, last429At: NOW.toISOString(), holdUntil: at(5_000).toISOString() });
    expect(first.rateLimited).toBe(true);
    expect(routeHoldAfter(hold({ attemptId: 42, entry: first.entry, now: at(1_000) }))).toBeNull();
  });

  it("with the halved interval the route's next send is ≥ 8 s (default), 10 s (list), 24 s (media) after its last", () => {
    for (const [route, gapMs] of [["messages.page", 8_000], ["messaging.groups", 10_000], ["media.offer_stats", 24_000]] as const) {
      const after = routeHoldAfter(hold({ route }))!;
      const state: RouteState = { routes: { [route]: after.entry } };
      const sends: SyncRouteSend[] = [{ journal: "engine", operation: route, lastAt: NOW }];
      const clocks = new RouteClocks({ sends, state });
      // The hold (5 s) is shorter than the halved interval: the interval rules.
      expect(clocks.notBefore(route)?.getTime(), route).toBe(NOW.getTime() + gapMs);
      // Only this route: its family's other members keep their pace.
      if (route === "messages.page") expect(clocks.notBefore("group.detail")?.getTime()).toBe(NOW.getTime() + 4_000);
    }
  });
});

describe("route holds: Retry-After and holds in force", () => {
  it("a valid Retry-After always wins, longer or shorter than the ladder, never clamped", () => {
    for (const retryAfterMs of [1_000, 42_000, 7_200_000]) {
      const next = routeHoldAfter(hold({ retryAfterMs, jitter: () => { throw new Error("no jitter on a Retry-After"); } }))!;
      expect(next.holdUntil).toEqual(at(retryAfterMs));
      // A 429 with Retry-After is still a 429: slowed, ladder stepped.
      expect(next.entry).toMatchObject({ ladderStep: 1, effectivePerMin: 7.5 });
    }
  });

  it("a later answer never shortens a hold in force", () => {
    const long = routeHoldAfter(hold({ retryAfterMs: 600_000 }))!;
    const short = routeHoldAfter(hold({ entry: long.entry, now: at(1_000), attemptId: 2, retryAfterMs: 2_000 }))!;
    expect(short.holdUntil).toEqual(at(600_000));
    expect(short.entry.effectivePerMin).toBe(3.75);
  });

  it("a 5xx naming its Retry-After holds the route to the letter without a slowdown, a ladder step or a 429 record", () => {
    const slowed = routeHoldAfter(hold({ attemptId: 3 }))!;
    const unavailable = routeHoldAfter(hold({ httpStatus: 503, retryAfterMs: 120_000, entry: slowed.entry, now: at(60_000), attemptId: 4 }))!;
    expect(unavailable.rateLimited).toBe(false);
    expect(unavailable.holdUntil).toEqual(at(180_000));
    expect(unavailable.entry).toEqual({ ...slowed.entry, holdUntil: at(180_000).toISOString(), revision: 2 });
    const fresh = routeHoldAfter(hold({ httpStatus: 503, retryAfterMs: 30_000 }))!;
    expect(fresh.entry).toEqual({
      holdUntil: at(30_000).toISOString(), ladderStep: 0, effectivePerMin: null, policyVersion: null,
      last429AttemptId: null, last429At: null, revision: 1,
    });
    expect(() => routeHoldAfter(hold({ httpStatus: 503, retryAfterMs: null }))).toThrow(/Retry-After/);
  });

  it("reads a route's hold in force at an instant", () => {
    const state: RouteState = {
      routes: {
        "messages.page": routeHoldAfter(hold())!.entry,
        "media.offer_stats": routeHoldAfter(hold({ route: "media.offer_stats", retryAfterMs: 60_000 }))!.entry,
        "transactions.page": { ...routeHoldAfter(hold({ route: "transactions.page" }))!.entry, holdUntil: null },
      },
    };
    expect(routeHoldUntil(state, "media.offer_stats", NOW)).toEqual(at(60_000));
    expect(routeHoldUntil(state, "messages.page", at(4_999))).toEqual(at(5_000));
    expect(routeHoldUntil(state, "messages.page", at(5_000))).toBeNull();
    expect(routeHoldUntil(state, "transactions.page", NOW)).toBeNull();
    expect(routeHoldUntil(EMPTY_ROUTE_STATE, "messages.page", NOW)).toBeNull();
  });

  it("the entry reads back from the route's rows of the hold set as written", () => {
    const entry = climb("media.offer_stats", 2)[1]!.entry;
    expect(routeStateOfHolds(routeHoldRows("media.offer_stats", entry))).toEqual({ ok: true, state: { routes: { "media.offer_stats": entry } } });
  });
});

describe("route holds: durable until a deliberate raise (A2, D3)", () => {
  it("a slowed route stays slowed: the ladder goes on from where it was, whatever came between", () => {
    const steps = climb("messages.page", 2);
    expect(routeSlowed("messages.page", steps[1]!.entry)).toBe(true);
    // A day later, after any number of successes: the next 429 takes step 2.
    const later = routeHoldAfter(hold({ entry: steps[1]!.entry, now: at(86_400_000), attemptId: 99 }))!;
    expect(later.holdUntil.getTime() - at(86_400_000).getTime()).toBe(20_000);
  });

  it("raises one step of at most +1/min against the evidence's revision; the hold in force and the ladder stay", () => {
    expect(ROUTE_RAISE_STEP_PER_MIN).toBe(1);
    const slowed = routeHoldAfter(hold({ retryAfterMs: 600_000 }))!.entry; // 7.5/min, revision 1, held 600 s
    const raised = routeRaise("messages.page", slowed, { toPerMin: 8.5, expectRevision: 1 });
    expect(raised).toEqual({
      ok: true,
      route: "messages.page",
      expectRevision: 1,
      fromPerMin: 7.5,
      toPerMin: 8.5,
      entry: { ...slowed, effectivePerMin: 8.5, revision: 2 },
    });
  });

  it("refuses a stale revision, a step above +1/min, a lowering, a rate above current, and a route not slowed", () => {
    const slowed = routeHoldAfter(hold())!.entry;
    expect(routeRaise("messages.page", slowed, { toPerMin: 8, expectRevision: 0 })).toMatchObject({ ok: false, reason: "stale_revision" });
    expect(routeRaise("messages.page", slowed, { toPerMin: 8.6, expectRevision: 1 })).toMatchObject({ ok: false, reason: "step_too_large" });
    expect(routeRaise("messages.page", slowed, { toPerMin: 15, expectRevision: 1 })).toMatchObject({ ok: false, reason: "step_too_large" });
    expect(routeRaise("messages.page", slowed, { toPerMin: 7.5, expectRevision: 1 })).toMatchObject({ ok: false, reason: "not_a_raise" });
    expect(routeRaise("messages.page", null, { toPerMin: 15, expectRevision: 0 })).toMatchObject({ ok: false, reason: "not_slowed" });
    // Media: current 5/min below the 12/min ceiling — a raise never passes current.
    const media = { ...routeHoldAfter(hold({ route: "media.offer_stats" }))!.entry, effectivePerMin: 4.5 };
    expect(routeRaise("media.offer_stats", media, { toPerMin: 5.5, expectRevision: 1 })).toMatchObject({ ok: false, reason: "above_current" });
    expect(routeRaise("media.offer_stats", { ...media, effectivePerMin: 5 }, { toPerMin: 5, expectRevision: 1 }))
      .toMatchObject({ ok: false, reason: "not_slowed" });
  });

  it("a 429 after the evidence moves the revision: the stale step is refused", () => {
    const first = routeHoldAfter(hold())!.entry;
    const second = routeHoldAfter(hold({ entry: first, now: at(60_000), attemptId: 2 }))!.entry;
    expect(routeRaise("messages.page", second, { toPerMin: 4.75, expectRevision: first.revision })).toMatchObject({ ok: false, reason: "stale_revision" });
    expect(routeRaise("messages.page", second, { toPerMin: 4.75, expectRevision: second.revision })).toMatchObject({ ok: true });
  });

  it("reaching current ends the slowdown; the next 429 starts the ladder over from current", () => {
    const at14 = { ...routeHoldAfter(hold())!.entry, effectivePerMin: 14, ladderStep: 4 };
    const raised = routeRaise("messages.page", at14, { toPerMin: 15, expectRevision: 1 });
    if (!raised.ok) throw new Error(raised.detail);
    expect(raised.entry).toMatchObject({ effectivePerMin: null, policyVersion: null, ladderStep: 4, revision: 2 });
    expect(routeSlowed("messages.page", raised.entry)).toBe(false);
    const next = routeHoldAfter(hold({ entry: raised.entry, now: at(HOUR_MS), attemptId: 9 }))!;
    expect(next.holdUntil.getTime() - at(HOUR_MS).getTime()).toBe(5_000);
    expect(next.entry).toMatchObject({ ladderStep: 1, effectivePerMin: routeBudget("messages.page").currentPerMin / 2, revision: 3 });
  });
});

describe("budgets-calibration.sql (A2: the evidence behind a step)", () => {
  const text = readFileSync(new URL("../apps/runtime/src/sync/budgets-calibration.sql", import.meta.url), "utf8");

  /** The rows of one `name (columns) as (values …)` table of the report. */
  function values(name: string): string[][] {
    const match = new RegExp(`\\b${name} \\([^)]*\\) as \\(values\\s*([\\s\\S]*?)\\n\\)`).exec(text);
    if (match === null) throw new Error(`no table ${name} in budgets-calibration.sql`);
    return [...match[1]!.matchAll(/\(([^)]*)\)/g)].map((row) => row[1]!.split(",").map((cell) => cell.trim().replace(/^'|'$/g, "")));
  }

  it("carries the budget table of fansly/routes.ts: every route budget, the default, the families and their budgets", () => {
    expect(values("route_budget")).toEqual(Object.entries(ROUTE_BUDGETS)
      .map(([route, budget]) => [route, String(budget!.ceilingPerMin), String(budget!.currentPerMin)]));
    expect(values("default_budget")).toEqual([[String(DEFAULT_ROUTE_BUDGET.ceilingPerMin), String(DEFAULT_ROUTE_BUDGET.currentPerMin)]]);
    expect(values("family_member")).toEqual(Object.entries(FANSLY_ROUTE_FAMILIES)
      .flatMap(([family, routes]) => routes.map((route) => [route, family])));
    expect(values("family_budget")).toEqual(Object.entries(FAMILY_BUDGETS)
      .map(([family, budget]) => [family, String(budget.ceilingPerMin), String(budget.currentPerMin)]));
  });

  it("proposes the raise lever's own command, and reads the route rows of the hold set", () => {
    expect(text).toContain("pnpm cli sync route raise --page %s --route %s --to %s --revision %s --evidence %L");
    expect(text).toContain("from sync_holds h");
    expect(text).toContain("where h.scope = 'route'");
    // The old columns are no source of it any more.
    expect(text).not.toMatch(/resource_holds|route:state/);
    expect(text).toContain(`ae.event_type = '${SYNC_ROUTE_RAISE_AUDIT_EVENT}'`);
    // Read-only: a report, never a write.
    expect(text).not.toMatch(/\b(insert|update|delete|truncate|alter|create|drop)\b\s/i);
  });
});
