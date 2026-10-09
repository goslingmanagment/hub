import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  insertLinkStatRun,
  insertLinkStatRunWithSnapshots,
  listLinkStatRuns,
  listLinkStatSeriesHealth,
  listNotificationIncidents,
  recordLinkStatWindowMissed,
  setPageOfapiAccountId,
  type LinkStatKind,
  type LinkStatRunStatus,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { runOfapiAccountHealthMonitor } from "../apps/runtime/src/services/ofapi-account-health.ts";
import {
  OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS,
  runOfapiLinkStatsSeriesMonitor,
  type OfapiLinkStatsSeriesMonitorState,
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
  ofapiAccountId = "acct_monitor",
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
    ofapiAccountId,
  };
  if (status === "complete" || status === "partial") {
    await insertLinkStatRunWithSnapshots(appContext.db, run, status === "complete"
      ? [{
        platformAccountId: pageId, linkKind, platformLinkId: "1", name: null, url: null,
        linkCreatedAt: null, linkEndsAt: null, isFinished: null, clicksCount: 1,
        claimsCount: linkKind === "trial" ? 1 : null, subscribersCount: 0, spendersCount: null,
        revenueNetMills: null, revenueChargebacksMills: null, revenueIsLoading: null,
        revenueCalculatedAt: null, trialDays: null, tags: null,
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

/** One monitor run. Each gets a fresh process state unless one is passed:
 * the state only matters for a series that never stamped a window. */
const monitor = (now: Date, state: OfapiLinkStatsSeriesMonitorState = { seenEnabledAt: null }) =>
  runOfapiLinkStatsSeriesMonitor(appContext, {
    now,
    authNeedsAction: (status) => status === "authentication_failed",
    state,
  });

/** The first window that opens at or after `at`. */
function firstOfWindowAtOrAfter(at: Date): Date {
  const windowAt = ofapiLinkStatsWindowAt(at);
  return windowAt.getTime() === at.getTime() ? windowAt : nextOfapiLinkStatsWindowAt(windowAt);
}

/** `count` windows back from `windowAt`. */
function windowsBack(windowAt: Date, count: number): Date {
  let back = windowAt;
  for (let step = 0; step < count; step += 1) back = previousOfapiLinkStatsWindowAt(back);
  return back;
}

async function windowMissedOf(pageId: number) {
  return (await listLinkStatRuns(appContext.db, { platformAccountId: pageId }))
    .filter((run) => run.reason === "window_missed")
    .map((run) => `${run.linkKind}@${run.windowAt?.toISOString()}`)
    .sort();
}

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

  it("a series whose job never fires is reported: from the first window after it was seen enabled, durably once a window is marked", async (context) => {
    if (!testDb) return context.skip();

    // A mapped page; the series is enabled; not one row was ever written.
    const page = await seedPage("monitor-never-of", "acct_monitor");
    const state: OfapiLinkStatsSeriesMonitorState = { seenEnabledAt: null };
    const seen = after(W0, 5 * MINUTE);
    const firstExpected = nextOfapiLinkStatsWindowAt(W0);

    expect(await monitor(seen, state)).toEqual({ stalePages: [], unmappedPages: [], windowMissedRows: 0 });
    expect(state.seenEnabledAt).toEqual(seen);
    // The first expected window closes: its hole is marked — a stamp, so the
    // anchor no longer depends on this process.
    const marked = await monitor(after(nextOfapiLinkStatsWindowAt(firstExpected), MINUTE), state);
    expect(marked.windowMissedRows).toBe(2);
    expect(await windowMissedOf(page.id)).toEqual([
      `tracking@${firstExpected.toISOString()}`,
      `trial@${firstExpected.toISOString()}`,
    ]);

    // A restart (fresh state) past the threshold: the stale latch opens.
    const staleAt = after(firstExpected, OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS + MINUTE);
    const stale = await monitor(staleAt);
    expect(stale.stalePages).toEqual([page.id]);
    const [incident] = await openIncidents();
    expect(incident!.key).toBe(`ofapi_link_stats_reconcile_failed:${page.id}:series_stale`);
    expect(incident!.summary).toContain(`tracking: no usable result since the first attempt at ${firstExpected.toISOString()}`);
    expect(incident!.summary).toContain("skipped: window missed");
  });

  it("a pair with no row at all is stale from the first window it was expected in", async (context) => {
    if (!testDb) return context.skip();

    // Another page anchors the series; this one was created later and the
    // job never wrote a row for it. The monitor would mark its closed
    // windows first (and the pair would count from that mark); here the
    // insert of those marks fails with a real error, so the run exercises
    // the pair that has no row at all — the safety net when marking cannot
    // happen — and the failed back-fill does not stop the judgement.
    const anchorPage = await seedPage("monitor-anchor-of", "acct_monitor");
    await attempt(anchorPage.id, "tracking", W0, "complete");
    await attempt(anchorPage.id, "trial", W0, "complete");
    const lonely = await seedPage("monitor-lonely-of", "acct_monitor_lonely");
    const createdAt = after(W0, HOUR);
    await testDb.pool.query(`update pages set created_at = $2 where id = $1`, [lonely.id, createdAt]);
    const firstExpected = nextOfapiLinkStatsWindowAt(W0);
    const staleAt = after(firstExpected, OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS + MINUTE);
    const client = await testDb.pool.connect();
    try {
      await client.query(
        `create or replace function no_window_missed() returns trigger language plpgsql as $$
           begin
             if new.reason = 'window_missed' and new.platform_account_id = ${lonely.id} then
               raise exception 'canceling statement due to lock timeout' using errcode = '55P03';
             end if;
             return new;
           end $$`,
      );
      await client.query(
        `create trigger no_window_missed before insert on page_link_stat_runs
           for each row execute function no_window_missed()`,
      );
    } finally {
      client.release();
    }
    try {
      const result = await monitor(staleAt);
      expect(result.stalePages).toContain(lonely.id);
      const summary = (await openIncidents())
        .find((incident) => incident.key === `ofapi_link_stats_reconcile_failed:${lonely.id}:series_stale`)!.summary;
      expect(summary).toBe([
        `tracking: no attempt at all since the first window it was expected in, ${firstExpected.toISOString()} — is the job running?`,
        `trial: no attempt at all since the first window it was expected in, ${firstExpected.toISOString()} — is the job running?`,
      ].join(" | "));
    } finally {
      await testDb.pool.query(`drop trigger if exists no_window_missed on page_link_stat_runs`);
      await testDb.pool.query(`drop function if exists no_window_missed()`);
    }
  });

  it("a back-fill that throws does not silence the signals: the stopped series and the unmapped page are still judged", async (context) => {
    if (!testDb) return context.skip();

    const stopped = await seedPage("monitor-throw-stopped-of", "acct_monitor");
    await attempt(stopped.id, "tracking", W0, "complete");
    await attempt(stopped.id, "trial", W0, "complete");
    const unmapped = await seedPage("monitor-throw-unmapped-of", null);
    await testDb.pool.query(
      `create or replace function window_missed_lock_timeout() returns trigger language plpgsql as $$
         begin
           if new.reason = 'window_missed' then
             raise exception 'canceling statement due to lock timeout' using errcode = '55P03';
           end if;
           return new;
         end $$`,
    );
    await testDb.pool.query(
      `create trigger window_missed_lock_timeout before insert on page_link_stat_runs
         for each row execute function window_missed_lock_timeout()`,
    );
    try {
      const result = await monitor(after(W0, OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS + HOUR));
      expect(result).toEqual({ stalePages: [stopped.id], unmappedPages: [unmapped.id], windowMissedRows: 0 });
      expect((await openIncidents()).map((incident) => incident.key)).toEqual([
        `ofapi_link_stats_reconcile_failed:${stopped.id}:series_stale`,
        `ofapi_link_stats_reconcile_failed:${unmapped.id}:page_unmapped`,
      ]);
      expect(await windowMissedOf(stopped.id)).toEqual([]);
    } finally {
      await testDb.pool.query(`drop trigger if exists window_missed_lock_timeout on page_link_stat_runs`);
      await testDb.pool.query(`drop function if exists window_missed_lock_timeout()`);
    }
  });

  it("after a rollback and redeploy, rows the previous image wrote without a window count for the window they were read in", async (context) => {
    if (!testDb) return context.skip();

    const page = await seedPage("monitor-rollback-of", "acct_monitor");
    const [first, rolledBack, quiet, open] = windowsFrom(W0, 4);
    await attempt(page.id, "tracking", first!, "complete");
    await attempt(page.id, "trial", first!, "complete");
    // Rolled back: the previous image keeps collecting, without a window.
    for (const linkKind of ["tracking", "trial"] as const) {
      await insertLinkStatRun(appContext.db, {
        platformAccountId: page.id, linkKind, status: "truncated", pulledAt: after(rolledBack!, 20_000),
        apiPages: 0, rawItems: 0, writtenRows: 0,
      });
    }
    // Redeployed only now: `quiet` really passed without any attempt.
    const result = await monitor(after(open!, 10 * MINUTE));
    expect(result.windowMissedRows).toBe(2);
    expect(await windowMissedOf(page.id)).toEqual([
      `tracking@${quiet!.toISOString()}`,
      `trial@${quiet!.toISOString()}`,
    ]);
    // The insert itself refuses a window an old-image row already covers.
    expect(await recordLinkStatWindowMissed(appContext.db, {
      platformAccountId: page.id, linkKind: "trial", windowAt: rolledBack!, windowEnd: quiet!,
    })).toBe(false);
  });

  it("after an outage longer than the look-back the last twelve windows are still marked, even once collection resumed", async (context) => {
    if (!testDb) return context.skip();

    const page = await seedPage("monitor-outage-of", "acct_monitor");
    const open = W0;
    const lastBefore = windowsBack(open, 20);
    await attempt(page.id, "tracking", lastBefore, "complete");
    await attempt(page.id, "trial", lastBefore, "complete");
    // Twenty windows of nothing — collector and monitor both down — then the
    // collector is back first: the open window has its rows.
    await attempt(page.id, "tracking", open, "complete");
    await attempt(page.id, "trial", open, "complete");

    const result = await monitor(after(open, 10 * MINUTE));
    expect(result.windowMissedRows).toBe(24);
    const marked = await windowMissedOf(page.id);
    const expected = Array.from({ length: 12 }, (_, index) => windowsBack(open, index + 1).toISOString())
      .flatMap((windowAt) => [`tracking@${windowAt}`, `trial@${windowAt}`])
      .sort();
    expect(marked).toEqual(expected);
    // Windows older than the look-back stay unmarked; a second run adds nothing.
    expect(marked.some((entry) => entry.endsWith(windowsBack(open, 13).toISOString()))).toBe(false);
    expect((await monitor(after(open, 11 * MINUTE))).windowMissedRows).toBe(0);
  });

  it("a cold cache after a rebind that persists goes stale; a kind that never had a link stays quiet", async (context) => {
    if (!testDb) return context.skip();

    const page = await seedPage("monitor-cold-of", "acct_monitor_cold_after");
    const windows = windowsFrom(W0, 6);
    // Before the rebind: tracking had links, trial never had one (lora-of).
    await attempt(page.id, "tracking", windows[0]!, "complete", null, "acct_monitor_cold_before");
    await attempt(page.id, "trial", windows[0]!, "partial", "empty_unverified", "acct_monitor_cold_before");
    // After it: the new account's cache stays cold for both kinds.
    for (const windowAt of windows.slice(1)) {
      await attempt(page.id, "tracking", windowAt, "partial", "empty_unverified");
      await attempt(page.id, "trial", windowAt, "partial", "empty_unverified");
    }
    const lastUsableTracking = after(windows[0]!, 20_000);
    const result = await monitor(after(lastUsableTracking, OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS + MINUTE));
    expect(result.stalePages).toEqual([page.id]);
    const [incident] = await openIncidents();
    expect(incident!.summary).toMatch(/^tracking: no usable result since .+; last attempt .+ partial: empty unverified$/);
    expect(incident!.summary).not.toContain("trial");
  });

  it("a newly connected page that reads empty ages toward series_stale; once the emptiness has lasted a day it counts and the latch resolves", async (context) => {
    if (!testDb) return context.skip();

    // Connected for the first time: tracking reads fine, trial reads empty —
    // a cold cache or a page with no trial links; for a day nothing tells.
    const page = await seedPage("monitor-new-empty-of", "acct_monitor");
    const DAY = 24 * HOUR;
    const firstDay = windowsFrom(W0, 8).filter((windowAt) => windowAt.getTime() + 20_000 < W0.getTime() + 20_000 + DAY);
    for (const windowAt of firstDay) {
      await attempt(page.id, "tracking", windowAt, "complete");
      await attempt(page.id, "trial", windowAt, "partial", "empty_unverified");
    }
    const firstEmpty = after(W0, 20_000);
    const staleAt = after(firstEmpty, OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS + MINUTE);
    const health = await listLinkStatSeriesHealth(appContext.db);
    expect(health.find((entry) => entry.linkKind === "trial")!.lastUsableAt).toBeNull();

    const stale = await monitor(staleAt);
    expect(stale.stalePages).toEqual([page.id]);
    const [incident] = await openIncidents();
    expect(incident!.summary).toMatch(/^trial: no usable result since the first attempt at .+ partial: empty unverified$/);

    // The emptiness has lasted a day: the page genuinely has no trial links,
    // the empty read counts, and the latch resolves.
    const dayLater = firstOfWindowAtOrAfter(after(W0, DAY));
    await attempt(page.id, "tracking", dayLater, "complete");
    await attempt(page.id, "trial", dayLater, "partial", "empty_unverified");
    await monitor(new Date(Math.max(after(dayLater, 5 * MINUTE).getTime(), after(staleAt, MINUTE).getTime())));
    expect(await openIncidents()).toEqual([]);
    expect((await listLinkStatSeriesHealth(appContext.db)).find((entry) => entry.linkKind === "trial")!.lastUsableAt)
      .toEqual(after(dayLater, 20_000));
  });

  it("a kind that has read empty for days (lora-of's trial links) stays a quiet result", async (context) => {
    if (!testDb) return context.skip();

    const page = await seedPage("monitor-long-empty-of", "acct_monitor");
    const history = windowsFrom(windowsBack(W0, 11), 12);
    for (const windowAt of history) {
      await attempt(page.id, "tracking", windowAt, "complete");
      await attempt(page.id, "trial", windowAt, "partial", "empty_unverified");
    }
    const result = await monitor(after(W0, 10 * MINUTE));
    expect(result).toEqual({ stalePages: [], unmappedPages: [], windowMissedRows: 0 });
    expect((await listLinkStatSeriesHealth(appContext.db)).find((entry) => entry.linkKind === "trial")!.lastUsableAt)
      .toEqual(after(W0, 20_000));
    expect(await openIncidents()).toEqual([]);
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
