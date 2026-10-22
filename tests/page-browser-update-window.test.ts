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
// another account or session than before the update, and Hub's requests
// through it refused as unlike the site's or held past their bound — a page
// can stay ready with them so.

let host: Host | undefined;
afterEach(() => {
  host?.cleanup();
  host = undefined;
});

const containerOf = (h: Host) => h.state().containers[`page-browser-${PAGE}`];
const update = (h: Host, env: Record<string, string> = {}) => h.run(["update", "--page", PAGE, "--image", TO, "--any-hour", "--window", "2s"], { env });

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
    ["Hub's requests held a moment (no template yet), then going", { reason: "no_template", clearAfterReads: 1 }],
    // ipify down: the operator holds Hub's requests up to its own 30 min, Chrome up.
    ["no exit IP confirmed for 15 min, then confirmed", { reason: "exit_ip_unknown", heldMs: 15 * 60_000, clearAfterReads: 1 }],
  ])("%s while the page stays ready: it passes", (_name, block) => {
    host = makeHost((state) => {
      state.behaviour.hubBlockAfterReadyReads = block;
    });
    expect(update(host).status).toBe(0);
    expect(host.update()).toMatchObject({ STEP: "done", WINDOW: "passed" });
  });

  it("the owner opens the manual login during it: the update holds for him, his browser is not rolled back", () => {
    host = makeHost((state) => {
      state.behaviour.manualLoginAfterReadyReads = { afterReadyReads: 1 };
    });
    const run = update(host);
    expect(run.status).toBe(1);
    expect(host.update()).toMatchObject({ STEP: "held" });
    expect(run.ops.filter((entry) => entry === "hub sync browser snapshot")).toHaveLength(1);
    expect(containerOf(host)).toMatchObject({ image: TO, running: true });
  });

  it.each<[string, Record<string, unknown>, Record<string, string>?]>([
    ["a stop of the browser in it, back ready between two looks (Chrome .39: cdp_lost)", { crashBetweenLooks: { reason: "cdp_lost" } }],
    ["a stop it stays in (Chrome crashed)", { failAfterReadyReads: 1, failStop: "chrome_crashed" }],
    ["an alarm of the browser's the operator's journal did not keep", { crashBetweenLooks: { reason: "cdp_lost", journal: false, selftest: false } }],
    ["another session: a new login", { sessionChangesAfterReadyReads: { fp: "e".repeat(64) } }],
    ["another account answers", { sessionChangesAfterReadyReads: { account: "222" } }],
    ["ready, Hub's requests refused: the site computes fansly-client-ts another way", { hubBlockAfterReadyReads: { reason: "client_check" } }],
    [
      "ready, Hub's requests held past their bound (2 s here): no template",
      { hubBlockAfterReadyReads: { reason: "no_template" } },
      { PB_UPDATE_HUB_SEND_WAIT_S: "2" },
    ],
    [
      "ready, Hub's requests held past their bound (2 s here): no exit IP confirmed",
      { hubBlockAfterReadyReads: { reason: "exit_ip_unknown" } },
      { PB_UPDATE_EXIT_IP_WAIT_S: "2" },
    ],
    [
      "Hub's requests held at its end (no exit IP), then the live session changed and the page went back below ready: never passed",
      {
        hubBlockAfterReadyReads: { reason: "exit_ip_unknown" },
        sessionChangesAfterReadyReads: { afterReadyReads: 3, fp: "e".repeat(64), account: "", step: "site_loaded" },
      },
      { PB_UPDATE_EXIT_IP_WAIT_S: "8" },
    ],
  ])("%s: rolled back, never judged by the hour", (_name, behaviour, env) => {
    host = makeHost((state) => {
      Object.assign(state.behaviour, behaviour);
    });
    const run = update(host, env);
    expect(run.status).toBe(1);
    expect(run.ops).not.toContain("hub sync check live-hour");
    expect(host.update()).toMatchObject({ STEP: "rolled_back" });
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
  });
});
