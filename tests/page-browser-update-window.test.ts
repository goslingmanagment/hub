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

import { FROM, makeHost, PAGE, TO, UPDATE_SCRIPT, writeExecutable, type Host } from "./helpers/page-browser-update.ts";

// Each test runs the script in bash against a fake server that starts a
// process per call: slower than a unit test, more so under a full parallel run.
vi.setConfig({ testTimeout: 180_000 });

// scripts/page-browser-update.sh — the window's verdict on a quiet hour.
// `sync check live-hour` leaves a window open (exit 2) when the hour gave
// its sample checks too little: lilly-1's update of 2026-10-17 was rolled
// back at 19:47 UTC on a clean hour for that alone. The window passes when
// the report shows nothing failed and nothing open but checks short of
// samples, none of them over its bound (quiet_hour); anything else open
// still rolls the page back. The reports here are made by the live-hour
// rules themselves, as the Hub prints them.

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

/** `sync check live-hour`'s report on lilly-1's window of 2026-10-17: every
 *  check passed but those the quiet hour left short of samples — no fan
 *  message, no media request, one money head read of 2.9 s — with `change`
 *  in place of its checks; and the CLI's exit code for it. */
function liveHour(change: Partial<Record<AcceptanceCheckName, AcceptanceCheck>> = {}): { report: LiveHourReport; exit: number } {
  const quiet: Partial<Record<AcceptanceCheckName, AcceptanceCheck>> = {
    route_429: { name: "route_429", verdict: "pass", detail: { routesWith429: 0, routes: [] } },
    media_start: mediaStartCheck([], WINDOW, false),
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
      page: PAGE, pageId: 1, mode: "live", liveSince: "2026-10-05T00:00:00.000Z", windowStart: START.toISOString(),
      verdict, reasons, checks, routes: [], failures: [], volume: [], restarts: { generations: [], connections: [] },
    }],
    accepted: isAcceptedVerdict(verdict),
  };
  return { report, exit: acceptanceExitCode(report) };
}

const open = (name: AcceptanceCheckName, detail: Record<string, unknown> = {}): AcceptanceCheck => ({ name, verdict: "inconclusive", detail });

/** quiet_hour of the script on `text` (its stdout, its status). */
function quietHour(text: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", 'set -euo pipefail; eval "$(sed -n "/^quiet_hour() {/,/^}/p" "$1")"; quiet_hour', "quiet", UPDATE_SCRIPT], {
    input: text,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}
const printed = (report: LiveHourReport) => `${JSON.stringify(report, null, 2)}\n`;

describe("the window on a quiet hour", () => {
  it("lilly-1's hour of 2026-10-17: open only for want of samples, nothing failed — the window passes", () => {
    const { report, exit } = liveHour();
    expect(exit).toBe(2);
    host = makeHost((state) => {
      state.behaviour.liveHourReport = report;
      state.behaviour.liveHourExit = exit;
    });
    const run = host.run([...UPDATE, "--window", "2s"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.ops).toEqual([...OUT_TO_IN, "hub sync check live-hour"]);
    expect(host.state().containers[`page-browser-${PAGE}`]).toMatchObject({ image: TO, running: true });
    expect(host.update()).toMatchObject({
      STEP: "done",
      WINDOW: "passed",
      WINDOW_QUIET: "confirm_mismatches, media_start, slo_confirm, slo_confirm_fast, slo_deletions, slo_find, slo_money_head, slo_repair, slo_visible",
    });
    expect(host.journal().find((line) => line.event === "window" && line.detail.startsWith("passed"))?.detail).toContain("open only for a quiet hour");
  });

  it("open for more than want of samples (pairs the pace audit could not judge): rolled back, as before", () => {
    const { report, exit } = liveHour({ pace_combined: open("pace_combined", { inconclusive: 2 }) });
    expect(exit).toBe(2);
    host = makeHost((state) => {
      state.behaviour.liveHourReport = report;
      state.behaviour.liveHourExit = exit;
    });
    const run = host.run([...UPDATE, "--window", "2s"]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual([...OUT_TO_IN, "hub sync check live-hour", ...ROLLBACK]);
    expect(host.update()).toMatchObject({ STEP: "rolled_back", RB_CHECKS: "passed" });
    expect(host.update().REASON).toContain("sync check live-hour over the window: exit 2");
    expect(host.update().WINDOW_QUIET).toBeUndefined();
    expect(host.state().containers[`page-browser-${PAGE}`]).toMatchObject({ image: FROM, running: true });
  });
});

describe("quiet_hour: which open windows a quiet hour explains", () => {
  it.each<[string, Partial<Record<AcceptanceCheckName, AcceptanceCheck>>]>([
    ["no sample at all on the open checks but one within its bound", {}],
    ["a few samples, every one within its bound (9 messages visible in 1 s)", { slo_visible: latencyCheck("slo_visible", Array<number>(9).fill(1)) }],
    ["one route's 429, recovered (accepted without the owner)", { route_429: { name: "route_429", verdict: "pass", detail: { routesWith429: 1, routes: [] } } }],
  ])("quiet: %s", (_, change) => {
    const { report, exit } = liveHour(change);
    expect(exit).toBe(2);
    const result = quietHour(printed(report));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("slo_money_head");
  });

  it.each<[string, Partial<Record<AcceptanceCheckName, AcceptanceCheck>>]>([
    ["a sample over its bound (one money head read of 13 s)", { slo_money_head: latencyCheck("slo_money_head", [13]) }],
    ["the first media request late (90 s)", { media_start: mediaStartCheck([mediaRequest(90)], WINDOW, false) }],
    ["the window not complete", { window_complete: open("window_complete") }],
    ["pairs the pace audit could not judge", { pace_combined: open("pace_combined", { inconclusive: 2 }) }],
    ["the hand-over boundary unproven", { handover_boundary: open("handover_boundary") }],
    ["a route's budget unproven", { route_budgets: open("route_budgets", { inconclusive: 1 }) }],
    ["a 429's recovery unproven", { route_429: open("route_429", { routesWith429: 1, routes: [] }) }],
    ["429s on two routes (the owner's review)", { route_429: { name: "route_429", verdict: "pass", detail: { routesWith429: 2, routes: [] } } }],
    ["a check failed", { nothing_stuck: { name: "nothing_stuck", verdict: "fail", detail: { attemptUnfinished: 1 } } }],
  ])("not quiet: %s", (_, change) => {
    const { report } = liveHour(change);
    const result = quietHour(printed(report));
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("reads the report among the CLI's other lines (the lever keeps stderr with stdout)", () => {
    const result = quietHour(`warning: a line on stderr\n${printed(liveHour().report)}(node) another\n`);
    expect(result.status, result.stderr).toBe(0);
  });

  it("no report, or jq that cannot read it: not a quiet hour", () => {
    expect(quietHour("sync check live-hour: connection refused\n").status).not.toBe(0);
    const bin = mkdtempSync(path.join(tmpdir(), "pb jq "));
    try {
      writeExecutable(path.join(bin, "jq"), "#!/usr/bin/env bash\nexit 127\n");
      expect(quietHour(printed(liveHour().report), { PATH: `${bin}:${process.env.PATH ?? ""}` }).status).not.toBe(0);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
