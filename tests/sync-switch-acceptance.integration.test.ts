import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@agency_hub_core/db";

import { acceptanceExitCode, checkSwitchAcceptance, type SwitchAcceptanceReport } from "../apps/runtime/src/sync/switch/acceptance.ts";
import { ACCEPTANCE_CHECKS } from "../apps/runtime/src/sync/switch/acceptance-rules.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedAcceptanceScenarios, type SeededAcceptance } from "./helpers/sync-acceptance-fixtures.ts";

// The live-hour acceptance (step 3b ruling 13, A6; plan PR 1-11) on its
// shared fixtures: `pnpm cli sync switch check` (switch/acceptance.ts) judges
// fourteen pages of one shared window — each after a stretch of legacy reads
// denser than the budgets, which are not the window's — page by page, check
// by check and route by route: a clean hour after a handover stop that ended
// before live (pass), one route 429 with its route incident open (recovered:
// accepted), the same 429 holding the whole page — alert 1 opened and
// resolved in the window (fail), a page stop only the paging sweep's history
// still shows (fail), a second 429 on the same route via another resource
// (fail), one each on two routes (the owner's review), a subject's 403
// (fail), a page hold the journal alone still shows (fail), a late 429 whose
// recovery is unproven (inconclusive), an open work's age in the SLO tail
// (fail), a small sample (inconclusive), a route closer than its recorded
// interval (fail), a route faster than the halved interval its admissions
// recorded after a 429 (fail), and the arena's 15 sends 2.8 s apart on a 4 s
// route that no window count catches (fail).

let testDb: StartedTestDatabase | null = null;
let seeded: SeededAcceptance | null = null;
let runtime: SwitchAcceptanceReport | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  const db = testDb.db as unknown as Database;
  seeded = await seedAcceptanceScenarios(db, testDb.pool);
  runtime = await checkSwitchAcceptance(db, { pageIds: seeded.pages.map((page) => page.pageId), since: seeded.since });
}, 240_000);

afterAll(async () => {
  await testDb?.stop();
});

function runtimePage(label: string) {
  const page = runtime!.pages.find((entry) => entry.page === label);
  if (page === undefined) throw new Error(`runtime has no page ${label}`);
  return page;
}

describe("the live-hour acceptance on its shared fixtures", () => {
  it("judges one complete window shared by the pages switched together", (context) => {
    if (!seeded) return context.skip();
    expect(runtime!.windowComplete).toBe(true);
    const starts = runtime!.pages.map((page) => Date.parse(page.windowStart));
    expect(Date.parse(runtime!.tStar)).toBe(Math.max(...starts));
    expect(Date.parse(runtime!.windowEnd)).toBe(Date.parse(runtime!.tStar) + 3_600_000);
    expect(runtime!.pages.map((page) => page.page).sort()).toEqual(seeded.pages.map((page) => page.label).sort());
    // Accepted pages and failed ones together: a page failed, so exit 1.
    expect(runtime!.accepted).toBe(false);
    expect(acceptanceExitCode(runtime!)).toBe(1);
  });

  it.for([
    "acc-clean", "acc-route-429", "acc-page-429", "acc-stop-history", "acc-same-route", "acc-two-routes", "acc-auth-403",
    "acc-page-hold", "acc-late-429", "acc-slo-tail", "acc-small-sample", "acc-budget", "acc-slowdown", "acc-route-gap",
  ])("%s: the scenario's verdict, check by check", (label, context) => {
    if (!seeded) return context.skip();
    const scenario = seeded.pages.find((page) => page.label === label)!;
    const cli = runtimePage(label);

    expect(cli.verdict).toBe(scenario.expected);
    const cliChecks = Object.fromEntries(cli.checks.map((check) => [check.name, check.verdict]));
    expect(Object.keys(cliChecks).sort()).toEqual([...ACCEPTANCE_CHECKS].sort());
    for (const [name, verdict] of Object.entries(scenario.expectedChecks)) {
      expect({ name, verdict: cliChecks[name] }).toEqual({ name, verdict });
    }
    // Every page's pairs carry their recorded pause and intervals: nothing is
    // left inconclusive by the audit.
    for (const name of ["pace_combined", "route_budgets"]) {
      expect({ name, inconclusive: cli.checks.find((check) => check.name === name)!.detail.inconclusive }).toEqual({ name, inconclusive: 0 });
    }

    const routes = cli.checks.find((check) => check.name === "route_429")!.detail.routes as Array<{ route: string; state: string }>;
    expect(Object.fromEntries(routes.map((entry) => [entry.route, entry.state]))).toEqual(scenario.expectedRoutes ?? {});
  });

  it("shows the route budgets' pairs, the 429s and the SLO tails", (context) => {
    if (!seeded) return context.skip();
    // The 429s of a page+route are listed by route whatever resource sent them.
    expect(runtimePage("acc-same-route").checks.find((check) => check.name === "route_429")!.detail.routes)
      .toEqual([expect.objectContaining({ route: "messages.page", count: 2, state: "repeated" })]);
    // Twenty-four media reads 5 s apart: twenty-three pairs short of 12 s, and
    // the media read before them (slot 99) 5 s before the first.
    const budget = runtimePage("acc-budget").checks.find((check) => check.name === "route_budgets")!.detail;
    expect(budget).toMatchObject({ violations: 24, inconclusive: 0 });
    expect((budget.first as Array<Record<string, unknown>>)[0]).toMatchObject({
      kind: "route", scope: "media.offer_stats", journal: "engine", gapMs: 5_000, intervalMs: 12_000,
    });
    // After the 429, the halved interval the admissions recorded: every 20 s is short of 24 s.
    const slowdown = runtimePage("acc-slowdown").checks.find((check) => check.name === "route_budgets")!.detail;
    expect((slowdown.first as Array<Record<string, unknown>>)[0]).toMatchObject({
      kind: "route", scope: "media.offer_stats", gapMs: 20_000, intervalMs: 24_000,
    });
    // The arena's counterexample: 14 pairs 2.8 s apart on a 4 s route; the page's pace held.
    const gap = runtimePage("acc-route-gap").checks;
    const gapBudgets = gap.find((check) => check.name === "route_budgets")!.detail;
    expect(gapBudgets).toMatchObject({
      violations: 14,
      scopes: expect.arrayContaining([expect.objectContaining({ kind: "route", scope: "notifications.page", sends: 15, pairs: 14, violations: 14 })]),
    });
    expect((gapBudgets.first as Array<Record<string, unknown>>)[0]).toMatchObject({
      kind: "route", scope: "notifications.page", gapMs: 2_800, intervalMs: 4_000,
    });
    expect(gap.find((check) => check.name === "pace_combined")!.detail).toMatchObject({ violations: 0, inconclusive: 0 });
    // A clean page: every pair judged, the smallest margin over its interval ≥ 0.
    const clean = runtimePage("acc-clean").checks.find((check) => check.name === "route_budgets")!.detail;
    expect(clean).toMatchObject({ violations: 0, inconclusive: 0, unplaced: [] });
    expect(Number(clean.pairs)).toBeGreaterThan(1_000);
    const tail = runtimePage("acc-slo-tail").checks.find((check) => check.name === "slo_find")!.detail;
    expect(tail).toMatchObject({ samples: 15, boundSeconds: 12 });
    expect(Number(tail.p95Seconds)).toBeGreaterThan(3_000);
    const small = runtimePage("acc-small-sample").checks.find((check) => check.name === "slo_confirm")!.detail;
    expect(small).toEqual({ samples: 5, maxSeconds: 5, boundSeconds: 30 });
    // The engine's failures by route, outcome, class and status.
    expect(runtimePage("acc-page-hold").failures).toEqual(["group.detail", "messages.page", "transactions.page"].map((route) => ({
      route, outcome: "transport_error", errorClass: "network", httpStatus: null, attempts: 1,
    })));
    expect(runtimePage("acc-route-429").failures).toEqual([
      { route: "messages.page", outcome: "response", errorClass: "rate_limit", httpStatus: 429, attempts: 1 },
    ]);
    expect(runtimePage("acc-clean").failures).toEqual([]);
  });

  it("finds the alert 1 episodes in the window: the latch's, the sweep's history, not a stop that ended before T_i", (context) => {
    if (!seeded) return context.skip();
    const opened = (detail: Record<string, unknown>) =>
      (detail.stopped as Array<{ openedAt: string }>).map((episode) => Date.parse(episode.openedAt));
    for (const [label, afterLiveS] of [["acc-clean", []], ["acc-route-429", []], ["acc-page-429", [1_002.4]], ["acc-stop-history", [1_200]]] as const) {
      const page = runtimePage(label);
      const cli = page.checks.find((check) => check.name === "page_hold")!.detail;
      const expected = afterLiveS.map((seconds) => Date.parse(page.windowStart) + seconds * 1_000);
      expect({ label, opened: opened(cli) }).toEqual({ label, opened: expected });
    }
    // The open route incident (code `route_held`) is shown, judged by the route rule.
    const incidents = runtimePage("acc-route-429").checks.find((check) => check.name === "open_incidents")!.detail.incidents;
    expect(incidents).toEqual([expect.objectContaining({ errorCode: "route_held", judgedByRouteRule: true })]);
  });

  it("an interim check before T* + 1 h is open (inconclusive) for a clean page, and fails a failing one at once", async (context) => {
    if (!seeded || !testDb) return context.skip();
    const db = testDb.db as unknown as Database;
    const pages = seeded.pages.filter((page) => page.label === "acc-clean" || page.label === "acc-auth-403");
    // A window ending in the future: nothing after now has happened yet.
    const until = new Date(Date.now() + 3_600_000);
    const report = await checkSwitchAcceptance(db, { pageIds: pages.map((page) => page.pageId), since: seeded.since, until });
    expect(report.windowComplete).toBe(false);
    for (const [label, verdict, reasons] of [["acc-clean", "inconclusive", ["window_complete"]], ["acc-auth-403", "fail", ["auth_refusals"]]] as const) {
      expect(report.pages.find((page) => page.page === label)).toMatchObject({ verdict, reasons });
    }
    expect(acceptanceExitCode(report)).toBe(1);
    const open = await checkSwitchAcceptance(db, { pageIds: [pages[0]!.pageId], since: seeded.since, until });
    expect(acceptanceExitCode(open)).toBe(2);
  });

  it("a page that is not live fails its live check from :since on", async (context) => {
    if (!seeded || !testDb) return context.skip();
    const db = testDb.db as unknown as Database;
    const page = seeded.pages.find((entry) => entry.label === "acc-clean")!;
    await testDb.pool.query("update sync_pages set mode = 'off' where page_id = $1", [page.pageId]);
    try {
      const report = await checkSwitchAcceptance(db, { pageIds: [page.pageId], since: seeded.since });
      expect(report.pages[0]).toMatchObject({ verdict: "fail", windowStart: seeded.since.toISOString() });
      expect(report.pages[0]!.reasons[0]).toBe("live");
    } finally {
      await testDb.pool.query("update sync_pages set mode = 'live' where page_id = $1", [page.pageId]);
    }
  });
});
