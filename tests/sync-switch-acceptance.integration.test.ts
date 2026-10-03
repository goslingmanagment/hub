import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@agency_hub_core/db";

import { acceptanceExitCode, checkSwitchAcceptance, type SwitchAcceptanceReport } from "../apps/runtime/src/sync/switch/acceptance.ts";
import { ACCEPTANCE_CHECKS } from "../apps/runtime/src/sync/switch/acceptance-rules.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  runAcceptanceSql,
  seedAcceptanceScenarios,
  type SeededAcceptance,
  type SqlPageVerdict,
} from "./helpers/sync-acceptance-fixtures.ts";

// The live-hour acceptance (step 3b ruling 13, A6; plan PR 1-11) on its
// shared fixtures: `pnpm cli sync switch check` (switch/acceptance.ts) and
// `step3-accept.sql` (psql 16, read-only, as prodsqlf.sh runs it) judge the
// same eleven pages of one shared window — each after a stretch of legacy
// reads denser than the budgets, which are not the window's — and must agree
// on every page's verdict, every check and every route's 429s: one route 429 (recovered:
// accepted), a second 429 on the same route via another resource (fail), one
// each on two routes (the owner's review), a subject's 403 (fail), a page
// hold the journal alone still shows (fail), a late 429 whose recovery is
// unproven (inconclusive), an open work's age in the SLO tail (fail), a small
// sample (inconclusive), a route over its budget (fail), a route at full rate
// after its 429 (fail).

let testDb: StartedTestDatabase | null = null;
let seeded: SeededAcceptance | null = null;
let runtime: SwitchAcceptanceReport | null = null;
let script: { output: string; verdicts: SqlPageVerdict[] } | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  const db = testDb.db as unknown as Database;
  seeded = await seedAcceptanceScenarios(db, testDb.pool);
  runtime = await checkSwitchAcceptance(db, { pageIds: seeded.pages.map((page) => page.pageId), since: seeded.since });
  script = await runAcceptanceSql(testDb.connectionString, { pages: seeded.pages.map((page) => page.label), since: seeded.since });
}, 240_000);

afterAll(async () => {
  await testDb?.stop();
});

function runtimePage(label: string) {
  const page = runtime!.pages.find((entry) => entry.page === label);
  if (page === undefined) throw new Error(`runtime has no page ${label}`);
  return page;
}

function sqlPage(label: string) {
  const page = script!.verdicts.find((entry) => entry.page === label);
  if (page === undefined) throw new Error(`step3-accept.sql has no page ${label}`);
  return page;
}

describe("the live-hour acceptance on its shared fixtures", () => {
  it("judges one complete window shared by the pages switched together", (context) => {
    if (!seeded) return context.skip();
    expect(runtime!.windowComplete).toBe(true);
    const starts = runtime!.pages.map((page) => Date.parse(page.windowStart));
    expect(Date.parse(runtime!.tStar)).toBe(Math.max(...starts));
    expect(Date.parse(runtime!.windowEnd)).toBe(Date.parse(runtime!.tStar) + 3_600_000);
    expect(script!.verdicts.map((page) => page.page).sort()).toEqual(seeded.pages.map((page) => page.label).sort());
    // Accepted pages and failed ones together: a page failed, so exit 1.
    expect(runtime!.accepted).toBe(false);
    expect(acceptanceExitCode(runtime!)).toBe(1);
  });

  it.for([
    "acc-clean", "acc-route-429", "acc-same-route", "acc-two-routes", "acc-auth-403", "acc-page-hold",
    "acc-late-429", "acc-slo-tail", "acc-small-sample", "acc-budget", "acc-slowdown",
  ])("%s: the CLI and the SQL reach the scenario's verdict, check by check", (label, context) => {
    if (!seeded) return context.skip();
    const scenario = seeded.pages.find((page) => page.label === label)!;
    const cli = runtimePage(label);
    const sql = sqlPage(label);

    expect(cli.verdict).toBe(scenario.expected);
    expect(sql.verdict).toBe(scenario.expected);
    expect(sql.reasons).toEqual(cli.reasons);
    const cliChecks = Object.fromEntries(cli.checks.map((check) => [check.name, check.verdict]));
    expect(Object.keys(cliChecks).sort()).toEqual([...ACCEPTANCE_CHECKS].sort());
    expect(sql.checks).toEqual(cliChecks);
    for (const [name, verdict] of Object.entries(scenario.expectedChecks)) {
      expect({ name, verdict: cliChecks[name] }).toEqual({ name, verdict });
    }

    const routes = cli.checks.find((check) => check.name === "route_429")!.detail.routes as Array<{ route: string; state: string }>;
    expect(Object.fromEntries(routes.map((entry) => [entry.route, entry.state]))).toEqual(scenario.expectedRoutes ?? {});
    expect(sql.routesWith429).toBe(routes.length);
  });

  it("shows the SQL's route 429s, budgets and SLO tails as the CLI counts them", (context) => {
    if (!seeded) return context.skip();
    const output = script!.output;
    // The 429s of a page+route are listed by route whatever resource sent them.
    expect(output).toMatch(/acc-same-route\|route_429\|fail\|.*"route" : "messages\.page", "count" : 2, "state" : "repeated"/);
    const budget = runtimePage("acc-budget").checks.find((check) => check.name === "route_budgets")!.detail;
    expect(budget.violations).toBeGreaterThan(0);
    expect(output).toContain(`acc-budget|route_budgets|fail|{"violations" : ${String(budget.violations)},`);
    const slowdown = runtimePage("acc-slowdown").checks.find((check) => check.name === "route_budgets")!.detail;
    expect((slowdown.first as Array<{ kind: string; scope: string; windowMs: number }>)[0]).toMatchObject({
      kind: "slowdown", scope: "media.offer_stats", windowMs: 300_000,
    });
    expect(output).toContain(`acc-slowdown|route_budgets|fail|{"violations" : ${String(slowdown.violations)},`);
    const tail = runtimePage("acc-slo-tail").checks.find((check) => check.name === "slo_find")!.detail;
    expect(tail).toMatchObject({ samples: 15, boundSeconds: 12 });
    expect(Number(tail.p95Seconds)).toBeGreaterThan(3_000);
    const small = runtimePage("acc-small-sample").checks.find((check) => check.name === "slo_confirm")!.detail;
    expect(small).toEqual({ samples: 5, maxSeconds: 5, boundSeconds: 30 });
    // The engine's failures by route, outcome, class and status (section 7).
    expect(runtimePage("acc-page-hold").failures).toEqual(["group.detail", "messages.page", "transactions.page"].map((route) => ({
      route, outcome: "transport_error", errorClass: "network", httpStatus: null, attempts: 1,
    })));
    for (const route of ["group.detail", "messages.page", "transactions.page"]) {
      expect(output).toContain(`acc-page-hold|${route}|transport_error|network||1`);
    }
    expect(runtimePage("acc-route-429").failures).toEqual([
      { route: "messages.page", outcome: "response", errorClass: "rate_limit", httpStatus: 429, attempts: 1 },
    ]);
    expect(output).toContain("acc-route-429|messages.page|response|rate_limit|429|1");
    expect(runtimePage("acc-clean").failures).toEqual([]);
  });

  it("an interim check before T* + 1 h is open (inconclusive) for a clean page, and fails a failing one at once", async (context) => {
    if (!seeded || !testDb) return context.skip();
    const db = testDb.db as unknown as Database;
    const pages = seeded.pages.filter((page) => page.label === "acc-clean" || page.label === "acc-auth-403");
    // A window ending in the future: nothing after now has happened yet.
    const until = new Date(Date.now() + 3_600_000);
    const report = await checkSwitchAcceptance(db, { pageIds: pages.map((page) => page.pageId), since: seeded.since, until });
    const sql = await runAcceptanceSql(testDb.connectionString, { pages: pages.map((page) => page.label), since: seeded.since, until });
    expect(report.windowComplete).toBe(false);
    for (const [label, verdict, reasons] of [["acc-clean", "inconclusive", ["window_complete"]], ["acc-auth-403", "fail", ["auth_refusals"]]] as const) {
      expect(report.pages.find((page) => page.page === label)).toMatchObject({ verdict, reasons });
      expect(sql.verdicts.find((page) => page.page === label)).toMatchObject({ verdict, reasons });
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
      const sql = await runAcceptanceSql(testDb.connectionString, { pages: [page.label], since: seeded.since });
      expect(report.pages[0]).toMatchObject({ verdict: "fail", windowStart: seeded.since.toISOString() });
      expect(report.pages[0]!.reasons[0]).toBe("live");
      expect(sql.verdicts[0]).toMatchObject({ verdict: "fail", reasons: report.pages[0]!.reasons });
    } finally {
      await testDb.pool.query("update sync_pages set mode = 'live' where page_id = $1", [page.pageId]);
    }
  });
});
