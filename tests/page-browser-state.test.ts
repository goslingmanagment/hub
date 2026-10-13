import { describe, expect, it } from "vitest";

import { PageState, type Transition } from "../apps/page-browser/src/state/page-state.ts";
import { RESTART_BACKOFF_MS, restartDelayMs, STEPS } from "../apps/page-browser/src/state/steps.ts";
import { parseStatus, shouldKill } from "../apps/page-browser/src/watchdog/watchdog.ts";

// The page's start (Project Browser plan §4.1): steps strictly in order, any
// failure back to the first with a reason and a retry after 10 s, 30 s,
// 2 min, then every 5 min; a halt holds until the engine starts the page.

function make(now = { t: 0 }) {
  const page = new PageState({ now: () => now.t });
  const transitions: Transition[] = [];
  page.onTransition = (transition) => transitions.push(transition);
  return { page, transitions, now };
}

const upTo = (page: PageState, last: (typeof STEPS)[number]) => {
  for (const step of STEPS.slice(1, STEPS.indexOf(last) + 1)) page.advance(step);
};

describe("the steps", () => {
  it("are the plan's ten, ending at ready", () => {
    expect(STEPS).toEqual(["exit_closed", "env_applied", "chrome_started", "control_attached", "selftest_passed", "exit_ip_verified", "exit_open", "site_loaded", "session_confirmed", "ready"]);
  });

  it("go one by one, never skipping one", () => {
    const { page, transitions } = make();
    page.beginStart("the engine's restartBrowser", true);
    expect(() => page.advance("chrome_started")).toThrow(/does not follow/);
    upTo(page, "exit_open");
    expect(transitions.map((transition) => transition.to)).toEqual(["env_applied", "chrome_started", "control_attached", "selftest_passed", "exit_ip_verified", "exit_open"]);
    expect(page.snapshot).toEqual({ step: "exit_open", stopReason: null, retryAtWall: null, halted: false });
  });
});

describe("a failure", () => {
  it("sends the page back to the first step, with its reason and a retry after 10 s, 30 s, 2 min, then 5 min", () => {
    const { page, now } = make({ t: 1_000 });
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      page.beginStart("a retry", false);
      upTo(page, "control_attached");
      const retryAt = page.fail("selftest_failed", "the self-test failed");
      delays.push(retryAt - now.t);
      expect(page.snapshot).toMatchObject({ step: "exit_closed", stopReason: "selftest_failed", halted: false, retryAtWall: retryAt });
    }
    expect(delays).toEqual([10_000, 30_000, 120_000, 300_000, 300_000, 300_000]);
    expect(RESTART_BACKOFF_MS).toEqual([10_000, 30_000, 120_000, 300_000]);
  });

  it("starts the ladder again after the page stayed open, or after the engine's explicit start", () => {
    const { page, now } = make({ t: 0 });
    page.fail("cdp_lost", "lost");
    page.fail("cdp_lost", "lost");
    expect(page.failures).toBe(2);
    page.beginStart("a retry", false);
    upTo(page, "exit_open");
    now.t += 5 * 60_000;
    expect(page.fail("cdp_lost", "lost") - now.t).toBe(10_000);
    page.fail("cdp_lost", "lost");
    page.beginStart("the engine's restartBrowser", true);
    expect(page.failures).toBe(0);
  });

  it("uses the engine's ladder", () => {
    const { page, now } = make({ t: 0 });
    page.setBackoff([150, 300]);
    expect(page.fail("cdp_lost", "lost") - now.t).toBe(150);
    expect(page.fail("cdp_lost", "lost") - now.t).toBe(300);
    expect(page.fail("cdp_lost", "lost") - now.t).toBe(300);
    expect(restartDelayMs(9, [1, 2])).toBe(2);
  });
});

describe("a halt", () => {
  it("holds: no step until the engine starts the page again", () => {
    const { page } = make();
    page.beginStart("start", true);
    upTo(page, "exit_open");
    page.halt("owner_stop", "the engine's stopPage");
    expect(page.snapshot).toEqual({ step: "exit_closed", stopReason: "owner_stop", retryAtWall: null, halted: true });
    expect(() => page.advance("env_applied")).toThrow(/halted/);
    page.beginStart("the engine's restartBrowser", true);
    expect(page.snapshot).toEqual({ step: "exit_closed", stopReason: null, retryAtWall: null, halted: false });
  });
});

describe("the exit closed on the engine's command", () => {
  it("keeps what was verified and goes back below the open exit", () => {
    const { page } = make();
    page.beginStart("start", true);
    upTo(page, "exit_open");
    page.exitClosed("the engine's closeExit");
    expect(page.snapshot).toMatchObject({ step: "exit_ip_verified", stopReason: null });
    page.advance("exit_open");
    expect(page.step).toBe("exit_open");
  });
});

describe("the watchdog", () => {
  it("kills an operator up for 5 s whose heartbeat is older than 5 s", () => {
    const status = parseStatus("true 123 42\n");
    expect(status).toEqual({ up: true, pid: 123, upForS: 42 });
    expect(shouldKill({ status, heartbeatAgeMs: 5001, thresholdMs: 5000 })).toBe(true);
    expect(shouldKill({ status, heartbeatAgeMs: null, thresholdMs: 5000 })).toBe(true);
    expect(shouldKill({ status, heartbeatAgeMs: 900, thresholdMs: 5000 })).toBe(false);
    // A new operator that has not beaten yet, a stale file from its predecessor.
    expect(shouldKill({ status: parseStatus("true 124 2"), heartbeatAgeMs: 60_000, thresholdMs: 5000 })).toBe(false);
    expect(shouldKill({ status: parseStatus("false -1 3"), heartbeatAgeMs: 60_000, thresholdMs: 5000 })).toBe(false);
  });
});
