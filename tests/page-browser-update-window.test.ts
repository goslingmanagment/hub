import { afterEach, describe, expect, it, vi } from "vitest";

import { FROM, makeHost, PAGE, TO, type Host } from "./helpers/page-browser-update.ts";

// Each test runs the script in bash against a fake server that starts a
// process per call: slower than a unit test, more so under a full parallel run.
vi.setConfig({ testTimeout: 180_000 });

// scripts/page-browser-update.sh — the window after an update judges the
// browser, never the engine's service of the page. `sync check live-hour`
// (the engine's first-hour acceptance) failed all six of lilly-1's windows
// and rolled a healthy browser back twice — 2026-10-17 07:48 onto Chrome
// .39, the one that crashed, for five hours: it runs at the window's end for
// the record only. What fails the window: a stop of the browser in it (by
// the operator's own record of every transition), an alarm of the browser's,
// another account or session than before the update.

let host: Host | undefined;
afterEach(() => {
  host?.cleanup();
  host = undefined;
});

const containerOf = (h: Host) => h.state().containers[`page-browser-${PAGE}`];
const update = (h: Host) => h.run(["update", "--page", PAGE, "--image", TO, "--any-hour", "--window", "2s"]);

/** `sync check live-hour`'s report of an hour that did not pass, as the CLI
 *  prints it: a latency SLO over its bound, as ari-1's slo_find was on its
 *  browser and on Node alike. */
const FAILED_HOUR = {
  windowComplete: true,
  pages: [{
    page: PAGE,
    verdict: "fail",
    reasons: ["slo_find"],
    checks: [
      { name: "window_complete", verdict: "pass", detail: {} },
      { name: "slo_find", verdict: "fail", detail: { samples: 12, p95Seconds: 17.7, maxSeconds: 18.6, boundSeconds: 12 } },
    ],
  }],
  accepted: false,
};

describe("the window judges the browser", () => {
  it("a healthy browser passes it whatever sync check live-hour says: the check runs, its verdict is kept for the record", () => {
    host = makeHost((state) => {
      state.behaviour.liveHourExit = 1;
      state.behaviour.liveHourReport = FAILED_HOUR;
    });
    const run = update(host);
    expect(run.status).toBe(0);
    expect(run.ops).toContain("hub sync check live-hour");
    expect(host.update()).toMatchObject({ STEP: "done", WINDOW: "passed", WINDOW_LIVE_HOUR: expect.stringContaining("slo_find") });
    expect(containerOf(host)).toMatchObject({ image: TO, running: true });
  });

  it.each<[string, Record<string, unknown>]>([
    ["a stop of the browser in it, back ready between two looks (Chrome .39: cdp_lost)", { crashBetweenLooks: { reason: "cdp_lost" } }],
    ["a stop it stays in (Chrome crashed)", { failAfterReadyReads: 1, failStop: "chrome_crashed" }],
    ["an alarm of the browser's the operator's journal did not keep", { crashBetweenLooks: { reason: "cdp_lost", journal: false, selftest: false } }],
    ["another session: a new login", { sessionChangesAfterReadyReads: { fp: "e".repeat(64) } }],
    ["another account answers", { sessionChangesAfterReadyReads: { account: "222" } }],
  ])("%s: rolled back, never judged by the hour", (_name, behaviour) => {
    host = makeHost((state) => {
      Object.assign(state.behaviour, behaviour);
    });
    const run = update(host);
    expect(run.status).toBe(1);
    expect(run.ops).not.toContain("hub sync check live-hour");
    expect(host.update()).toMatchObject({ STEP: "rolled_back" });
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
  });
});
