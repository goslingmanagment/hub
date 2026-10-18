import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acceptanceExitCode, type LiveHourReport } from "../apps/runtime/src/sync/checks/live-hour.ts";
import {
  ACCEPTANCE_CHECKS,
  isAcceptedVerdict,
  latencyCheck,
  mediaStartCheck,
  mismatchCheck,
  pageVerdict,
  type AcceptanceCheck,
  type AcceptanceCheckName,
  type AcceptanceWindow,
} from "../apps/runtime/src/sync/checks/live-hour-rules.ts";

import { FROM, makeHost, PAGE, TO, UPDATE_SCRIPT, writeExecutable, type FakeState, type Host } from "./helpers/page-browser-update.ts";

// Each test runs the script in bash against a fake server that starts a
// process per call: slower than a unit test, more so under a full parallel run.
vi.setConfig({ testTimeout: 180_000 });

// scripts/page-browser-update.sh — the window after an update, and its
// verdict. lilly-1's updates of 2026-10-17 were rolled back twice on a
// healthy browser: at 07:48 for two requests the old Chrome had left
// unfinished at 06:42 (nothing_stuck counts the page as it stands), at
// 19:47 for a quiet hour (live-hour open for want of samples). And the
// window, a look at the engine's record every five minutes, passed a
// browser that crashed and came back in between (Chrome .39: 63 % of its
// crash hours, by the model on its history). The window now passes a page
// only when its operator's record shows the browser never stood and never
// started again in it, and `sync check live-hour` accepted the hour or left
// short of a pass only what says nothing of the browser. The reports here
// are made by the live-hour rules themselves, as the Hub prints them.

let host: Host | undefined;
afterEach(() => {
  host?.cleanup();
  host = undefined;
});

const UPDATE = ["update", "--page", PAGE, "--image", TO, "--any-hour"];
const OUT_TO_IN = ["hub sync browser snapshot", "docker stop", "profile snapshot", `page.sh up ${TO}`, "profile-check", "hub sync browser start"];
const ROLLBACK = ["hub sync browser snapshot", "docker stop", "profile restore", `page.sh up ${FROM}`, "profile-check", "hub sync browser start"];

const START = new Date("2026-10-17T18:46:53Z");
const END = new Date("2026-10-17T19:46:57Z");
const WINDOW: AcceptanceWindow = { start: START, end: END, observedUntil: END, now: new Date(END.getTime() + 3_000) };

/** A media request of the engine `seconds` after the window's start. */
function mediaRequest(seconds: number) {
  const at = new Date(START.getTime() + seconds * 1_000);
  return {
    journal: "engine" as const, ref: 1, operation: "media.offer_stats", resource: "r", at, doneAt: at,
    outcome: "response", httpStatus: 200, retryAfterMs: null, errorClass: null,
  };
}

/** nothing_stuck with these counts (the rest 0). */
function stuck(counts: Record<string, number>): AcceptanceCheck {
  const detail = { attemptUnfinished: 0, applyPending: 0, attemptQuarantined: 0, workQuarantined: 0, receiptsPending: 0, urgentWaiting: 0, fanThreadsBehind: 0, ...counts };
  return { name: "nothing_stuck", verdict: Object.values(detail).every((value) => value === 0) ? "pass" : "fail", detail };
}

/** `sync check live-hour`'s report on lilly-1's window of 2026-10-17 19:47:
 *  every check passed but those the quiet hour left short of samples — no
 *  fan message, no media request, one money head read of 2.9 s — with
 *  `change` in place of its checks; and the CLI's exit code for it. */
function liveHour(change: Partial<Record<AcceptanceCheckName, AcceptanceCheck>> = {}): { report: LiveHourReport; exit: number } {
  const quiet: Partial<Record<AcceptanceCheckName, AcceptanceCheck>> = {
    route_429: { name: "route_429", verdict: "pass", detail: { routesWith429: 0, routes: [] } },
    media_start: mediaStartCheck([], WINDOW, false),
    nothing_stuck: stuck({}),
    slo_visible: latencyCheck("slo_visible", []),
    slo_confirm: latencyCheck("slo_confirm", []),
    slo_confirm_fast: latencyCheck("slo_confirm_fast", []),
    confirm_mismatches: mismatchCheck(0, 0),
    slo_find: latencyCheck("slo_find", []),
    slo_money_head: latencyCheck("slo_money_head", [2.9]),
    slo_deletions: latencyCheck("slo_deletions", []),
    slo_repair: latencyCheck("slo_repair", []),
  };
  const checks = ACCEPTANCE_CHECKS.map((name): AcceptanceCheck => change[name] ?? quiet[name] ?? { name, verdict: "pass", detail: {} });
  const { verdict, reasons } = pageVerdict(checks);
  const report: LiveHourReport = {
    since: START.toISOString(),
    until: END.toISOString(),
    tStar: START.toISOString(),
    windowEnd: END.toISOString(),
    observedUntil: END.toISOString(),
    windowComplete: checks.find((check) => check.name === "window_complete")!.verdict === "pass",
    pages: [{
      page: PAGE, pageId: 4, mode: "live", liveSince: "2026-10-02T20:50:32.251Z", windowStart: START.toISOString(),
      verdict, reasons, checks, routes: [], failures: [], volume: [], restarts: { generations: [], connections: [] },
    }],
    accepted: isAcceptedVerdict(verdict),
  };
  return { report, exit: acceptanceExitCode(report) };
}

/** Every check passed: the hour accepted. */
function accepted(): { report: LiveHourReport; exit: number } {
  const pass = (name: AcceptanceCheckName): AcceptanceCheck => ({ name, verdict: "pass", detail: {} });
  const all = Object.fromEntries(ACCEPTANCE_CHECKS.map((name) => [name, name === "route_429" ? { name, verdict: "pass", detail: { routesWith429: 0 } } : pass(name)]));
  return liveHour(all as Partial<Record<AcceptanceCheckName, AcceptanceCheck>>);
}

const open = (name: AcceptanceCheckName, detail: Record<string, unknown> = {}): AcceptanceCheck => ({ name, verdict: "inconclusive", detail });
const printed = (report: LiveHourReport) => `${JSON.stringify(report, null, 2)}\n`;

/** The 07:48 hour: nothing_stuck by two of the old Chrome's site requests,
 *  the first media request 2621 s into it, the SLOs short of samples. */
const HOUR_0748 = () => liveHour({ nothing_stuck: stuck({ attemptUnfinished: 2 }), media_start: mediaStartCheck([mediaRequest(2621.3)], WINDOW, false) });

describe("the window's verdict: sync check live-hour's exit code and report", () => {
  type Outcome = "passed" | "rolled_back" | "held";
  it.each<[string, () => { report: LiveHourReport; exit: number }, (state: FakeState) => void, Outcome, Record<string, unknown>]>([
    ["accepted (exit 0)", accepted, () => undefined, "passed", {}],
    [
      "lilly-1, 19:47: open only for want of samples, nothing failed (exit 2)",
      () => liveHour(),
      () => undefined,
      "passed",
      { WINDOW_OPEN: "confirm_mismatches, media_start, slo_confirm, slo_confirm_fast, slo_deletions, slo_find, slo_money_head, slo_repair, slo_visible", WINDOW_TAILS: "" },
    ],
    [
      "lilly-1, 07:48: nothing_stuck by two attempts left before the hand-over, which stand still (exit 1)",
      HOUR_0748,
      (state) => {
        state.hub.pages[PAGE]!.stuck = ["attempt 345394", "attempt 345395"];
      },
      "passed",
      { WINDOW_TAILS: "attemptUnfinished 2 (attempt 345394,345395, from before the hand-over)" },
    ],
    [
      "nothing_stuck by an attempt the new browser left (exit 1)",
      () => liveHour({ nothing_stuck: stuck({ attemptUnfinished: 1 }) }),
      (state) => {
        state.behaviour.stuckAfterReady = ["attempt 900"];
      },
      "rolled_back",
      { REASON: expect.stringContaining("nothing_stuck: attemptUnfinished 1, 0 of them standing from before the hand-over") },
    ],
    [
      "nothing_stuck by a tail and a new attempt beside it (exit 1)",
      () => liveHour({ nothing_stuck: stuck({ attemptUnfinished: 2 }) }),
      (state) => {
        state.hub.pages[PAGE]!.stuck = ["attempt 345394"];
        state.behaviour.stuckAfterReady = ["attempt 345394", "attempt 900"];
      },
      "rolled_back",
      { REASON: expect.stringContaining("attemptUnfinished 2, 1 of them standing from before") },
    ],
    [
      "nothing_stuck by urgent work waiting — the page as it stands, not a tail (exit 1)",
      () => liveHour({ nothing_stuck: stuck({ urgentWaiting: 1 }) }),
      (state) => {
        state.hub.pages[PAGE]!.stuck = ["attempt 345394"];
      },
      "rolled_back",
      { REASON: expect.stringContaining("nothing_stuck: urgentWaiting 1") },
    ],
    [
      "open for more than want of samples: pairs the pace audit could not judge (exit 2)",
      () => liveHour({ pace_combined: open("pace_combined", { inconclusive: 2 }) }),
      () => undefined,
      "rolled_back",
      { REASON: expect.stringContaining(`exit 2 (${PAGE} inconclusive: pace_combined,`) },
    ],
    [
      "a sample over its bound (one money head read of 13 s, exit 2)",
      () => liveHour({ slo_money_head: latencyCheck("slo_money_head", [13]) }),
      () => undefined,
      "rolled_back",
      { REASON: expect.stringContaining("sync check live-hour over the window: exit 2") },
    ],
    [
      "a check failed: a fan's message unconfirmed for 15 min (exit 1)",
      () => liveHour({ unconfirmed_over_15m: { name: "unconfirmed_over_15m", verdict: "fail", detail: { messages: 1, withoutThread: 0 } } }),
      () => undefined,
      "rolled_back",
      { REASON: expect.stringContaining(`exit 1 (${PAGE} fail: unconfirmed_over_15m)`) },
    ],
  ])("%s", (_, hour, setup, outcome, expected) => {
    const { report, exit } = hour();
    host = makeHost((state) => {
      state.behaviour.liveHourReport = report;
      state.behaviour.liveHourExit = exit;
      setup(state);
    });
    const run = host.run([...UPDATE, "--window", "2s"]);
    if (outcome === "passed") {
      expect(run.status, run.stderr).toBe(0);
      expect(run.ops).toEqual([...OUT_TO_IN, "hub sync check live-hour"]);
      expect(host.update()).toMatchObject({ STEP: "done", WINDOW: "passed", ...expected });
      if (exit === 0) expect(host.update().WINDOW_OPEN).toBeUndefined();
      expect(host.state().containers[`page-browser-${PAGE}`]).toMatchObject({ image: TO, running: true });
    } else {
      expect(run.status).toBe(1);
      expect(run.ops).toEqual([...OUT_TO_IN, "hub sync check live-hour", ...ROLLBACK]);
      expect(host.update()).toMatchObject({ STEP: "rolled_back", RB_CHECKS: "passed", ...expected });
      expect(host.update().WINDOW).toBeUndefined();
      expect(host.state().containers[`page-browser-${PAGE}`]).toMatchObject({ image: FROM, running: true });
    }
  });

  it("what stood unfinished is read before the page is given back, and once", () => {
    const { report, exit } = HOUR_0748();
    host = makeHost((state) => {
      state.behaviour.liveHourReport = report;
      state.behaviour.liveHourExit = exit;
      state.hub.pages[PAGE]!.stuck = ["attempt 345394", "attempt 345395"];
    });
    const run = host.run([...UPDATE, "--window", "2s"]);
    expect(run.status, run.stderr).toBe(0);
    const reads = run.calls.flatMap((call, index) => (call.stdin?.includes("-- pb-update:stuck") ? [index] : []));
    const start = run.calls.findIndex((call) => call.args.includes("start") && call.args.includes("browser"));
    // One read before the start, one at the window's end.
    expect(reads).toHaveLength(2);
    expect(reads[0]!).toBeLessThan(start);
    expect(reads[1]!).toBeGreaterThan(start);
    expect(host.update().TAILS_BEFORE).toBe("2");
  });

  it("the Hub cannot be read for what stands unfinished before the hand-over: held, the page not given back", () => {
    host = makeHost((state) => {
      state.behaviour.stuckFails = true;
    });
    const run = host.run([...UPDATE, "--window", "2s"]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(OUT_TO_IN.slice(0, -1));
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "host_checked" });
    expect(host.update().HELD_WHY).toContain("what stands unfinished on the page before its hand-over is unknown");
  });

  it("no report to judge — the CLI could not read the Hub (exit 1): held, never judged blind", () => {
    host = makeHost((state) => {
      state.behaviour.liveHourOutput = "sync check live-hour: connect ECONNREFUSED 172.18.0.4:5432\n";
      state.behaviour.liveHourExit = 1;
    });
    const run = host.run([...UPDATE, "--window", "2s"]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual([...OUT_TO_IN, "hub sync check live-hour"]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "engine_checked" });
    expect(host.update().HELD_WHY).toContain("gave no report to judge (exit 1)");
    expect(host.state().containers[`page-browser-${PAGE}`]).toMatchObject({ image: TO, running: true });
  });

  it("reads the report among the CLI's other lines (the lever keeps stderr with stdout)", () => {
    const { report, exit } = liveHour();
    host = makeHost((state) => {
      state.behaviour.liveHourOutput = `warning: a line on stderr\n${printed(report)}(node) another\n`;
      state.behaviour.liveHourExit = exit;
    });
    const run = host.run([...UPDATE, "--window", "2s"]);
    expect(run.status, run.stderr).toBe(0);
    expect(host.update()).toMatchObject({ STEP: "done", WINDOW: "passed" });
  });
});

describe("the window's look: the browser's own transitions, not a look every few minutes", () => {
  it.each<[string, Record<string, unknown>, string]>([
    ["it crashed and came back between two looks (cdp_lost, its self-test run again)", { afterReadyReads: 1 }, "during the window: stopped: cdp_lost at "],
    ["the same, its self-test as it was: the operator's record alone tells it", { afterReadyReads: 1, selftest: false }, "during the window: stopped: cdp_lost at "],
    ["the same, the record silent on it: the self-test after it was ready tells it", { afterReadyReads: 1, journal: false }, "during the window: its browser started again: a self-test at "],
    ["any stop of the browser not the owner's (its proxy)", { afterReadyReads: 1, reason: "proxy_unavailable", selftest: false }, "during the window: stopped: proxy_unavailable at "],
  ])("%s, the engine's record ready at every look: rolled back", (_, crash, why) => {
    host = makeHost((state) => {
      state.behaviour.crashBetweenLooks = crash;
    });
    const run = host.run([...UPDATE, "--window", "3s"]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual([...OUT_TO_IN, ...ROLLBACK]);
    expect(host.update()).toMatchObject({ STEP: "rolled_back", RB_CHECKS: "passed" });
    expect(host.update().REASON).toContain(why);
  });

  it("a stop before the page was ready is not the window's: it passes", () => {
    host = makeHost((state) => {
      state.hub.pages[PAGE]!.states = [{ at: new Date(Date.now() - 60_000).toISOString(), from: "ready", to: "exit_closed", stopReason: "cdp_lost", retryAtWall: null, halted: false, note: "on the old Chrome" }];
    });
    const run = host.run([...UPDATE, "--window", "2s"]);
    expect(run.status, run.stderr).toBe(0);
    expect(host.update()).toMatchObject({ STEP: "done", WINDOW: "passed" });
  });

  it("the owner stops and starts its browser between two looks: held, his — never a rollback for his doing", () => {
    host = makeHost((state) => {
      state.behaviour.ownerStopsBetweenLooks = { afterReadyReads: 1 };
    });
    const run = host.run([...UPDATE, "--window", "3s"]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(OUT_TO_IN);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "engine_checked" });
    expect(host.update().HELD_WHY).toContain("during the window: the owner stopped its browser at ");
    expect(host.state().containers[`page-browser-${PAGE}`]).toMatchObject({ image: TO, running: true });
  });

  it("the owner runs a self-test of its browser between two looks (no start): held, his", () => {
    host = makeHost((state) => {
      state.behaviour.ownerSelfTestBetweenLooks = { afterReadyReads: 1 };
    });
    const run = host.run([...UPDATE, "--window", "3s"]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(OUT_TO_IN);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "engine_checked" });
    expect(host.update().HELD_WHY).toContain("during the window: the owner's self-test of its browser ran at ");
  });

  it.each<[string, (state: FakeState) => void, string]>([
    ["its operator's journal lost lines (a gap)", (state) => {
      state.behaviour.gapAfterReadyReads = 1;
    }, "3 lines of it lost at "],
    ["its operator's journal cannot be read", (state) => {
      state.behaviour.logFails = true;
    }, "the operator's record of the page's transitions cannot be read"],
  ])("%s: held — not seen is not failed, nor passed", (_, setup, why) => {
    host = makeHost(setup);
    const run = host.run([...UPDATE, "--window", "3s"]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(OUT_TO_IN);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "engine_checked" });
    expect(host.update().HELD_WHY).toContain(why);
    expect(host.update().WINDOW).toBeUndefined();
  });
});

/** window_accepts of the script on `text`, <tails> (its stdout, its status). */
function windowAccepts(text: string, tails = false, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", 'set -euo pipefail; eval "$(sed -n "/^window_accepts() {/,/^}/p" "$1")"; window_accepts "$2"', "accepts", UPDATE_SCRIPT, String(tails)], {
    input: text,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("window_accepts: what live-hour leaves short of a pass that says nothing of the browser", () => {
  it.each<[string, Partial<Record<AcceptanceCheckName, AcceptanceCheck>>, boolean]>([
    ["no sample at all on the open checks but one within its bound", {}, false],
    ["a few samples, every one within its bound (9 messages visible in 1 s)", { slo_visible: latencyCheck("slo_visible", Array<number>(9).fill(1)) }, false],
    ["one route's 429, recovered (accepted without the owner)", { route_429: { name: "route_429", verdict: "pass", detail: { routesWith429: 1, routes: [] } } }, false],
    ["the first media request late (90 s): the walk's own schedule on a page live for long", { media_start: mediaStartCheck([mediaRequest(90)], WINDOW, false) }, false],
    ["no media request, the walk paused by its owner (a fail of the go-live rule)", { media_start: mediaStartCheck([], WINDOW, true) }, false],
    ["nothing_stuck by tails alone", { nothing_stuck: stuck({ attemptUnfinished: 2 }) }, true],
  ])("accepted: %s", (_, change, tails) => {
    const { report, exit } = liveHour(change);
    expect(exit).not.toBe(0);
    const result = windowAccepts(printed(report), tails);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("slo_money_head");
  });

  it.each<[string, Partial<Record<AcceptanceCheckName, AcceptanceCheck>>, boolean]>([
    ["a sample over its bound (one money head read of 13 s)", { slo_money_head: latencyCheck("slo_money_head", [13]) }, false],
    ["the window not complete", { window_complete: open("window_complete") }, false],
    ["pairs the pace audit could not judge", { pace_combined: open("pace_combined", { inconclusive: 2 }) }, false],
    ["the hand-over boundary unproven", { handover_boundary: open("handover_boundary") }, false],
    ["a route's budget unproven", { route_budgets: open("route_budgets", { inconclusive: 1 }) }, false],
    ["a 429's recovery unproven", { route_429: open("route_429", { routesWith429: 1, routes: [] }) }, false],
    ["429s on two routes (the owner's review)", { route_429: { name: "route_429", verdict: "pass", detail: { routesWith429: 2, routes: [] } } }, false],
    ["nothing_stuck, not by tails alone", { nothing_stuck: stuck({ attemptUnfinished: 1 }) }, false],
    ["nothing_stuck by tails, beside another failed check", { nothing_stuck: stuck({ attemptUnfinished: 1 }), open_incidents: { name: "open_incidents", verdict: "fail", detail: { incidents: [] } } }, true],
    ["a fan's message unconfirmed for 15 min", { unconfirmed_over_15m: { name: "unconfirmed_over_15m", verdict: "fail", detail: { messages: 1 } } }, false],
  ])("not accepted: %s", (_, change, tails) => {
    const { report } = liveHour(change);
    const result = windowAccepts(printed(report), tails);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("no report, or jq that cannot read it: not accepted", () => {
    expect(windowAccepts("sync check live-hour: connection refused\n").status).not.toBe(0);
    const bin = mkdtempSync(path.join(tmpdir(), "pb jq "));
    try {
      writeExecutable(path.join(bin, "jq"), "#!/usr/bin/env bash\nexit 127\n");
      expect(windowAccepts(printed(liveHour().report), false, { PATH: `${bin}:${process.env.PATH ?? ""}` }).status).not.toBe(0);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
