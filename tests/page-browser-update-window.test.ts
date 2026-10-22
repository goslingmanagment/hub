import { afterEach, describe, expect, it, vi } from "vitest";

import { acceptanceExitCode, type LiveHourReport } from "../apps/runtime/src/sync/checks/live-hour.ts";
import {
  ACCEPTANCE_CHECKS,
  isAcceptedVerdict,
  latencyCheck,
  pageVerdict,
  type AcceptanceCheck,
} from "../apps/runtime/src/sync/checks/live-hour-rules.ts";

import { makeHost, PAGE, TO, type Call, type Host } from "./helpers/page-browser-update.ts";

// Each test runs the script in bash against a fake server that starts a
// process per call: slower than a unit test, more so under a full parallel run.
vi.setConfig({ testTimeout: 180_000 });

// scripts/page-browser-update.sh — the window after an update, judged by
// `sync check live-hour`. A latency SLO over its bound is the engine's as
// often as the browser's: ari-1's slo_find (first demand to its work
// closed) was p95 17.7 s, max 18.6 s against 12 s on its browser, and p95
// 71.5 s, max 101.7 s on Node the evening before (audit 2026-10-22). The
// window then judges such a check against the page's own hour before the
// update — read-only, the same check, ending before the update began — and
// passes it only when no worse; with no such hour to compare, or worse
// than it, the window fails as before. The reports are made by the
// live-hour rules themselves, as the Hub prints them.

let host: Host | undefined;
afterEach(() => {
  host?.cleanup();
  host = undefined;
});

/** A report of the page's hour: every check passed but slo_find, of these
 *  samples (seconds), and the CLI's exit code for it. */
function hour(find: number[]): { report: LiveHourReport; exit: number } {
  const checks = ACCEPTANCE_CHECKS.map((name): AcceptanceCheck => name === "slo_find"
    ? latencyCheck("slo_find", find)
    : { name, verdict: "pass", detail: name === "route_429" ? { routesWith429: 0 } : {} });
  const { verdict, reasons } = pageVerdict(checks);
  const at = "2026-10-22T10:00:00.000Z";
  const report: LiveHourReport = {
    since: at, until: at, tStar: at, windowEnd: at, observedUntil: at, windowComplete: true,
    pages: [{
      page: PAGE, pageId: 4, mode: "live", liveSince: "2026-10-02T20:50:32.251Z", windowStart: at,
      verdict, reasons, checks, routes: [], failures: [], volume: [], restarts: { generations: [], connections: [] },
    }],
    accepted: isAcceptedVerdict(verdict),
  };
  return { report, exit: acceptanceExitCode(report) };
}

/** The window: ten finds, p95 18.1 s, max 18.6 s, over the 12 s bound. */
const WINDOW = hour([9.8, 10.4, 11.2, 12.5, 13.1, 14, 15.2, 16.3, 17.5, 18.6]);

/** The --since and --until of each `sync check live-hour` the run asked. */
function liveHourSpans(calls: Call[]) {
  return calls
    .map((call) => call.args)
    .filter((args) => args.includes("live-hour"))
    .map((args) => ({ since: Date.parse(args[args.indexOf("--since") + 1]!), until: Date.parse(args[args.indexOf("--until") + 1]!) }));
}

describe("a latency SLO over its bound: judged against the page's own hour before the update", () => {
  it.each<[string, number[], "done" | "rolled_back"]>([
    ["slower the hour before (ari-1 on Node): the window passes", [31, 35, 40, 44, 52, 58, 63, 66, 70, 71.5, 80, 101.7], "done"],
    ["faster the hour before: the browser's hour is worse — rolled back", [5, 6, 7, 8, 9, 9.5, 10, 10.5, 11, 11.5], "rolled_back"],
    ["no find the hour before: nothing to compare — rolled back, as before", [], "rolled_back"],
    [
      "a find the hour before outlasting the gap to the update (it may hold the update's own stop): not compared — rolled back",
      [31, 35, 40, 44, 52, 58, 63, 66, 70, 1000],
      "rolled_back",
    ],
  ])("%s", (_name, before, outcome) => {
    host = makeHost((state) => {
      state.behaviour.liveHours = [WINDOW, hour(before)];
    });
    const run = host.run(["update", "--page", PAGE, "--image", TO, "--any-hour", "--window", "2s"]);
    const update = host.update();
    expect(update.STEP).toBe(outcome);
    // What passed it, and against what: the window's max and the hour before's.
    if (outcome === "done") expect(update).toMatchObject({ WINDOW: "passed", WINDOW_BASELINE: expect.stringMatching(/18\.6 s.*101\.7 s/) });
    // The hour before: as long as the window, ending a quarter of an hour
    // before the update began — never a moment of the new browser.
    const [window, baseline] = liveHourSpans(run.calls);
    expect(baseline!.until).toBe(Date.parse(update.STARTED_AT!) - 900_000);
    expect(baseline!.until - baseline!.since).toBe(window!.until - window!.since);
  });
});
