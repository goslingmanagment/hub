import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  insertLinkStatRun,
  insertLinkStatRunWithSnapshots,
  listLinkStatRuns,
  listLinkStatSeriesHealth,
  listNotificationIncidents,
  setPageOfapiAccountId,
  type LinkStatKind,
  type LinkStatRunStatus,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { runOfapiAccountHealthMonitor } from "../apps/runtime/src/services/ofapi-account-health.ts";
import {
  OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS,
  runOfapiLinkStatsSeriesMonitor,
} from "../apps/runtime/src/services/ofapi-link-stats-monitor.ts";
import {
  nextOfapiLinkStatsWindowAt,
  ofapiLinkStatsWindowAt,
  previousOfapiLinkStatsWindowAt,
} from "../apps/runtime/src/services/ofapi-link-stats-windows.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Traffic sources plan §2.10 and П9.1: the minutely watchman of the OnlyFans
// link series. Its freshness is the latest USABLE result per (page, kind):
// attempt rows — failed, skipped, the monitor's own window_missed — never
// move it.

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, {
    ofapiLinkStatsReconcileEnabled: true,
    ofapiCreditLedgerEnabled: true,
    ofapiAccountHealthEnabled: true,
  });
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A window well in the past of every page this file creates. */
const W0 = ofapiLinkStatsWindowAt(new Date("2026-10-08T12:00:00Z"));
const PAGES_CREATED_AT = new Date(W0.getTime() - 30 * 24 * HOUR);
const after = (base: Date, ms: number) => new Date(base.getTime() + ms);

function windowsFrom(first: Date, count: number): Date[] {
  const windows: Date[] = [first];
  while (windows.length < count) windows.push(nextOfapiLinkStatsWindowAt(windows[windows.length - 1]!));
  return windows;
}

async function seedPage(label: string, ofapiAccountId: string | null) {
  const model = await createModel(appContext.db, { slug: `model-${label}`, name: `Model ${label}` });
  if (!model) throw new Error("model seed failed");
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  if (!page) throw new Error("page seed failed");
  if (ofapiAccountId !== null) {
    await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId });
  }
  await testDb!.pool.query(`update pages set created_at = $2 where id = $1`, [page.id, PAGES_CREATED_AT]);
  return page;
}

/** One attempt row, as the reconcile writes it. */
async function attempt(
  pageId: number,
  linkKind: LinkStatKind,
  windowAt: Date,
  status: LinkStatRunStatus,
  reason: string | null = null,
) {
  const run = {
    platformAccountId: pageId,
    linkKind,
    status,
    pulledAt: after(windowAt, 20_000),
    apiPages: status === "skipped" ? 0 : 1,
    rawItems: status === "complete" ? 1 : 0,
    writtenRows: status === "complete" ? 1 : 0,
    reason,
    windowAt,
    ofapiAccountId: "acct_monitor",
  };
  if (status === "complete" || status === "partial") {
    await insertLinkStatRunWithSnapshots(appContext.db, run, status === "complete"
      ? [{
        platformAccountId: pageId, linkKind, platformLinkId: "1", name: null, url: null,
        linkCreatedAt: null, linkEndsAt: null, isFinished: null, clicksCount: 1,
        claimsCount: linkKind === "trial" ? 1 : null, subscribersCount: 0, spendersCount: null,
        revenueGrossMills: null, revenueIsLoading: null, revenueCalculatedAt: null,
      }]
      : []);
  } else {
    await insertLinkStatRun(appContext.db, run);
  }
}

async function openIncidents() {
  return (await listNotificationIncidents(appContext.db, { status: "open" }))
    .filter((incident) => incident.kind === "ofapi_link_stats_reconcile_failed")
    .map((incident) => ({ key: incident.incidentKey, summary: incident.errorSummary }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

const monitor = (now: Date) => runOfapiLinkStatsSeriesMonitor(appContext, {
  now,
  authNeedsAction: (status) => status === "authentication_failed",
});

describe("the link series monitor", () => {
  it("one kind keeps failing while the other works: the failing one goes stale, its rows and the window_missed rows do not keep it fresh", async (context) => {
    if (!testDb) return context.skip();

    const page = await seedPage("monitor-mixed-of", "acct_monitor");
    // Enough windows to pass the threshold: tracking lands in every one,
    // trial lands in the first and fails in all the others (with retries).
    const windows = windowsFrom(W0, 8);
    for (const [index, windowAt] of windows.entries()) {
      await attempt(page.id, "tracking", windowAt, "complete");
      if (index === 0) {
        await attempt(page.id, "trial", windowAt, "complete");
      } else {
        for (let retry = 0; retry < 4; retry += 1) {
          await attempt(page.id, "trial", windowAt, "failed", "trial endpoint down");
        }
      }
    }
    const lastUsableTrial = after(windows[0]!, 20_000);
    const staleAt = after(lastUsableTrial, OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS + MINUTE);
    // Run the monitor at a moment inside the last seeded window, past the
    // threshold for trial.
    expect(staleAt.getTime()).toBeLessThan(nextOfapiLinkStatsWindowAt(windows[7]!).getTime());

    const quiet = await monitor(after(lastUsableTrial, OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS - MINUTE));
    expect(quiet.stalePages).toEqual([]);
    expect(await openIncidents()).toEqual([]);

    const result = await monitor(staleAt);
    expect(result.stalePages).toEqual([page.id]);
    expect(await openIncidents()).toEqual([{
      key: `ofapi_link_stats_reconcile_failed:${page.id}:series_stale`,
      summary: expect.stringMatching(/^trial: no usable result since .+; last attempt .+ failed: trial endpoint down$/),
    }]);
    expect((await openIncidents())[0]!.summary).not.toContain("tracking");

    // Tracking's fresh results did not lend trial their freshness.
    const health = await listLinkStatSeriesHealth(appContext.db);
    expect(health.find((entry) => entry.linkKind === "trial")!.lastUsableAt).toEqual(lastUsableTrial);

    // Trial reads again: the next run resolves the latch.
    const healedWindow = nextOfapiLinkStatsWindowAt(windows[7]!);
    await attempt(page.id, "tracking", healedWindow, "complete");
    await attempt(page.id, "trial", healedWindow, "complete");
    await monitor(after(healedWindow, 5 * MINUTE));
    expect(await openIncidents()).toEqual([]);
  });

  it("a window that passes without any attempt gets one window_missed row per pair, and it is not a result", async (context) => {
    if (!testDb) return context.skip();

    const page = await seedPage("monitor-missed-of", "acct_monitor");
    // The series ran in W0, then the job did not start for two windows.
    await attempt(page.id, "tracking", W0, "complete");
    await attempt(page.id, "trial", W0, "complete");
    const [, missedA, missedB, open] = windowsFrom(W0, 4);
    const now = after(open!, 10 * MINUTE);

    const result = await monitor(now);
    expect(result.windowMissedRows).toBe(4);
    for (const kind of ["tracking", "trial"] as const) {
      const runs = (await listLinkStatRuns(appContext.db, { platformAccountId: page.id, linkKind: kind })).reverse();
      expect(runs.map((run) => [run.windowAt?.toISOString(), run.status, run.reason, run.attempt, run.ofapiAccountId]))
        .toEqual([
          [W0.toISOString(), "complete", null, 1, "acct_monitor"],
          [missedA!.toISOString(), "skipped", "window_missed", 1, null],
          [missedB!.toISOString(), "skipped", "window_missed", 1, null],
        ]);
      // pulled_at of a window_missed row is the window itself.
      expect(runs[1]!.pulledAt).toEqual(missedA);
    }
    // The open window is not marked: its pass may still come.
    expect((await listLinkStatRuns(appContext.db, { platformAccountId: page.id }))
      .some((run) => run.windowAt?.getTime() === open!.getTime())).toBe(false);

    // A second run writes nothing more.
    expect((await monitor(after(now, MINUTE))).windowMissedRows).toBe(0);
    // And the rows do not count as results.
    const health = await listLinkStatSeriesHealth(appContext.db);
    expect(health.map((entry) => entry.lastUsableAt)).toEqual([after(W0, 20_000), after(W0, 20_000)]);
    expect(health.map((entry) => entry.lastAttemptReason)).toEqual(["window_missed", "window_missed"]);
  });

  it("marks nothing before the series stamped its first window, and nothing for a page created after a window opened", async (context) => {
    if (!testDb) return context.skip();

    const old = await seedPage("monitor-old-of", "acct_monitor");
    const [, second, third] = windowsFrom(W0, 3);
    // Rows the previous image wrote: no window at all.
    await insertLinkStatRun(appContext.db, {
      platformAccountId: old.id, linkKind: "tracking", status: "truncated", pulledAt: after(W0, -HOUR),
      apiPages: 0, rawItems: 0, writtenRows: 0,
    });
    expect((await monitor(after(third!, MINUTE))).windowMissedRows).toBe(0);

    // The first stamped window is `second`; a page appears halfway through it.
    await attempt(old.id, "tracking", second!, "complete");
    await attempt(old.id, "trial", second!, "complete");
    const late = await seedPage("monitor-late-of", "acct_monitor_late");
    await testDb.pool.query(`update pages set created_at = $2 where id = $1`, [late.id, after(second!, HOUR)]);

    const result = await monitor(after(nextOfapiLinkStatsWindowAt(third!), MINUTE));
    // `third` passed without attempts for both pages; `second` is marked for
    // nobody: `old` had its rows, `late` did not exist when it opened.
    expect(result.windowMissedRows).toBe(4);
    const windowOf = async (pageId: number) => (await listLinkStatRuns(appContext.db, { platformAccountId: pageId }))
      .filter((run) => run.reason === "window_missed")
      .map((run) => run.windowAt?.toISOString())
      .sort();
    expect(await windowOf(old.id)).toEqual([third!.toISOString(), third!.toISOString()]);
    expect(await windowOf(late.id)).toEqual([third!.toISOString(), third!.toISOString()]);
    expect(previousOfapiLinkStatsWindowAt(third!)).toEqual(second);
  });

  it("an unmapped page opens page_unmapped at once and resolves when it is mapped; it gets no second, stale latch for the same cause", async (context) => {
    if (!testDb) return context.skip();

    const page = await seedPage("monitor-unmapped-of", null);
    // Its series: skipped rows only, for longer than the stale threshold.
    for (const windowAt of windowsFrom(W0, 6)) {
      await attempt(page.id, "tracking", windowAt, "skipped", "page_unmapped");
      await attempt(page.id, "trial", windowAt, "skipped", "page_unmapped");
    }
    const now = after(W0, OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS + HOUR);

    const result = await monitor(now);
    expect(result).toMatchObject({ unmappedPages: [page.id], stalePages: [] });
    expect(await openIncidents()).toEqual([{
      key: `ofapi_link_stats_reconcile_failed:${page.id}:page_unmapped`,
      summary: expect.stringContaining("no OFAPI account mapping"),
    }]);

    // Mapped again (the reconciler or the owner): the latch resolves; the
    // series has had no result for a long time and has not been read under
    // the mapping yet, so now the stale latch speaks.
    await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: "acct_monitor_new" });
    const mapped = await monitor(after(now, MINUTE));
    expect(mapped).toMatchObject({ unmappedPages: [], stalePages: [page.id] });
    expect((await openIncidents()).map((incident) => incident.key)).toEqual([
      `ofapi_link_stats_reconcile_failed:${page.id}:series_stale`,
    ]);
  });

  it("a dead session gets no stale latch of its own (ofapi_auth owns it); one already open stays until the series is written", async (context) => {
    if (!testDb) return context.skip();

    const page = await seedPage("monitor-authdead-of", "acct_monitor");
    await attempt(page.id, "tracking", W0, "complete");
    await attempt(page.id, "trial", W0, "complete");
    const staleAt = after(W0, OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS + HOUR);

    await testDb.pool.query(`update pages set ofapi_auth_status = 'authentication_failed' where id = $1`, [page.id]);
    expect((await monitor(staleAt)).stalePages).toEqual([]);
    expect(await openIncidents()).toEqual([]);

    // Stale while the session was alive, then the session dies: the latch
    // that was opened stays open — it is not "written again".
    await testDb.pool.query(`update pages set ofapi_auth_status = null where id = $1`, [page.id]);
    expect((await monitor(staleAt)).stalePages).toEqual([page.id]);
    await testDb.pool.query(`update pages set ofapi_auth_status = 'authentication_failed' where id = $1`, [page.id]);
    await monitor(after(staleAt, MINUTE));
    expect((await openIncidents()).map((incident) => incident.key)).toEqual([
      `ofapi_link_stats_reconcile_failed:${page.id}:series_stale`,
    ]);
  });

  it("runs inside the minutely account-health monitor, and not at all while the series is off", async (context) => {
    if (!testDb) return context.skip();

    const page = await seedPage("monitor-wired-of", null);
    await runOfapiAccountHealthMonitor(appContext, after(W0, MINUTE));
    expect((await openIncidents()).map((incident) => incident.key)).toEqual([
      `ofapi_link_stats_reconcile_failed:${page.id}:page_unmapped`,
    ]);

    await resetIntegrationDatabase(testDb.pool);
    appContext = createTestAppContext(testDb, {
      ofapiLinkStatsReconcileEnabled: false,
      ofapiCreditLedgerEnabled: true,
      ofapiAccountHealthEnabled: true,
    });
    await seedPage("monitor-off-of", null);
    await runOfapiAccountHealthMonitor(appContext, after(W0, MINUTE));
    expect(await openIncidents()).toEqual([]);
  });

  it("a page whose series is fresh and mapped costs no incident write", async (context) => {
    if (!testDb) return context.skip();

    const page = await seedPage("monitor-healthy-of", "acct_monitor");
    await attempt(page.id, "tracking", W0, "complete");
    await attempt(page.id, "trial", W0, "partial", "empty_unverified");
    // The empty partial on a pair that never had a link is a result: the
    // free page has no trial links at all.
    const result = await monitor(after(W0, 10 * MINUTE));
    expect(result).toEqual({ stalePages: [], unmappedPages: [], windowMissedRows: 0 });
    expect(await listNotificationIncidents(appContext.db)).toEqual([]);
  });
});
