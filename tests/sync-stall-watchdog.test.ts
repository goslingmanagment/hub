import { afterEach, describe, expect, it, vi } from "vitest";

import { SYNC_TAKEOVER_FACTOR } from "@agency_hub_core/db";
import { FANSLY_PAUSE_MAX_MS } from "@agency_hub_core/shared";

import { SYNC_POOL_TIMEOUTS } from "../apps/runtime/src/sync/context.ts";
import { REQUEST_TIMEOUT_MS } from "../apps/runtime/src/sync/engine/pacer.ts";
import {
  noStallTracker,
  SYNC_STALL_AFTER_MS,
  SYNC_STALL_CHECK_MS,
  SYNC_STALL_EXIT_CODE,
  SYNC_STALL_REPORT_TIMEOUT_MS,
  SyncStallWatchdog,
  type SyncStall,
} from "../apps/runtime/src/sync/engine/watchdog.ts";
import { describeSyncStall, SYNC_SHUTDOWN_CAP_MS } from "../apps/runtime/src/sync/main.ts";

// Step 4, 4-3 layer 1: the stall watchdog's pure core on a fake clock. A
// tracker that has not moved for 120 s ends the process — one line on stderr,
// the incident (bounded), exit 70 — once, and never after the runtime began
// to stop.

class FakeClock {
  now = 1_000;
  monoNow(): number {
    return this.now;
  }
  advance(ms: number): void {
    this.now += ms;
  }
}

function harness(options: { report?: (stall: SyncStall) => Promise<void>; staleAfterMs?: number } = {}) {
  const clock = new FakeClock();
  const events: string[] = [];
  const lines: string[] = [];
  const exits: number[] = [];
  const watchdog = new SyncStallWatchdog({
    clock,
    exit: (code) => {
      events.push(`exit:${code}`);
      exits.push(code);
    },
    writeStderr: (line) => {
      events.push("stderr");
      lines.push(line);
    },
    report: options.report ?? (async (stall) => {
      events.push(`report:${stall.component}`);
    }),
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
  });
  return { clock, events, lines, exits, watchdog };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the stall watchdog", () => {
  it("a tracker younger than 120 s is no stall; one that has not moved for 120 s is", async () => {
    const { clock, watchdog, exits } = harness();
    watchdog.track({ component: "actor", pageId: 4, generation: 12n }, "recover");
    clock.advance(SYNC_STALL_AFTER_MS - 1);
    expect(watchdog.check()).toBeNull();
    clock.advance(1);
    expect(watchdog.check()).toEqual({
      component: "actor",
      pageId: 4,
      generation: "12",
      phase: "recover",
      ageMs: SYNC_STALL_AFTER_MS,
      stale: 1,
    });
    await watchdog.exiting;
    expect(exits).toEqual([SYNC_STALL_EXIT_CODE]);
  });

  it("progress starts the age again and names the phase; done stops watching", async () => {
    const { clock, watchdog, exits } = harness();
    const actor = watchdog.track({ component: "actor", pageId: 4, generation: 1n }, "recover");
    const beat = watchdog.track({ component: "heartbeat" }, "beat");
    for (let lap = 0; lap < 10; lap += 1) {
      clock.advance(SYNC_STALL_AFTER_MS - 1_000);
      actor.progress(lap % 2 === 0 ? "slot" : "send");
      beat.done();
      expect(watchdog.check()).toBeNull();
    }
    expect(watchdog.tracked).toBe(1);
    clock.advance(SYNC_STALL_AFTER_MS);
    expect(watchdog.check()).toMatchObject({ component: "actor", phase: "send", ageMs: SYNC_STALL_AFTER_MS });
    await watchdog.exiting;
    expect(exits).toEqual([70]);
  });

  it("reports the oldest stale tracker and how many are stale", async () => {
    const { clock, watchdog } = harness();
    watchdog.track({ component: "host" }, "list_pages");
    clock.advance(10_000);
    watchdog.track({ component: "actor", pageId: 7, generation: 3n }, "admit");
    clock.advance(5_000);
    watchdog.track({ component: "alerts" }, "pages");
    clock.advance(SYNC_STALL_AFTER_MS);
    expect(watchdog.check()).toEqual({
      component: "host",
      pageId: null,
      generation: null,
      phase: "list_pages",
      ageMs: SYNC_STALL_AFTER_MS + 15_000,
      stale: 3,
    });
    await watchdog.exiting;
  });

  it("writes its line, then the incident, then exits 70 — once", async () => {
    const { clock, watchdog, events, lines } = harness();
    watchdog.track({ component: "actor", pageId: 4, generation: 2n }, "admit");
    clock.advance(SYNC_STALL_AFTER_MS);
    watchdog.check();
    clock.advance(SYNC_STALL_AFTER_MS);
    expect(watchdog.check()).toBeNull();
    await watchdog.exiting;
    expect(events).toEqual(["stderr", "report:actor", "exit:70"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0]!)).toEqual({
      msg: "Fansly sync: stalled; exiting for a restart",
      component: "actor",
      pageId: 4,
      generation: "2",
      phase: "admit",
      ageMs: SYNC_STALL_AFTER_MS,
      stale: 1,
    });
  });

  it("exits even when the incident fails, or never answers within 2 s", async () => {
    const failing = harness({ report: async () => {
      throw new Error("database down");
    } });
    failing.watchdog.track({ component: "heartbeat" }, "beat");
    failing.clock.advance(SYNC_STALL_AFTER_MS);
    failing.watchdog.check();
    await failing.watchdog.exiting;
    expect(failing.exits).toEqual([70]);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hanging = harness({ report: () => new Promise<void>(() => undefined) });
    hanging.watchdog.track({ component: "host" }, "list_pages");
    hanging.clock.advance(SYNC_STALL_AFTER_MS);
    hanging.watchdog.check();
    await vi.advanceTimersByTimeAsync(SYNC_STALL_REPORT_TIMEOUT_MS - 1);
    expect(hanging.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await hanging.watchdog.exiting;
    expect(hanging.exits).toEqual([70]);
  });

  it("stops when the runtime begins to stop: nothing is watched, nothing exits", () => {
    const { clock, watchdog, exits } = harness();
    watchdog.track({ component: "actor", pageId: 4, generation: 1n }, "send");
    watchdog.stop();
    expect(watchdog.tracked).toBe(0);
    expect(watchdog.track({ component: "host" }, "release")).toBe(noStallTracker);
    clock.advance(10 * SYNC_STALL_AFTER_MS);
    expect(watchdog.check()).toBeNull();
    expect(watchdog.exiting).toBeNull();
    expect(exits).toEqual([]);
  });

  it("an exit under way is not called off by a stop", async () => {
    const { clock, watchdog, exits } = harness();
    watchdog.track({ component: "alerts" }, "page");
    clock.advance(SYNC_STALL_AFTER_MS);
    watchdog.check();
    watchdog.stop();
    await watchdog.exiting;
    expect(exits).toEqual([70]);
  });

  it("looks every 5 s on a timer that never keeps the process alive", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const { clock, watchdog, exits } = harness();
    const check = vi.spyOn(watchdog, "check");
    const timers = vi.spyOn(globalThis, "setInterval");
    watchdog.start();
    expect(timers).toHaveBeenCalledTimes(1);
    expect((timers.mock.results[0]!.value as NodeJS.Timeout).hasRef()).toBe(false);
    watchdog.track({ component: "host" }, "list_pages");
    clock.advance(SYNC_STALL_AFTER_MS);
    await vi.advanceTimersByTimeAsync(SYNC_STALL_CHECK_MS - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    await watchdog.exiting;
    expect(exits).toEqual([70]);
    // After the stall the timer is gone: no second exit.
    await vi.advanceTimersByTimeAsync(10 * SYNC_STALL_CHECK_MS);
    expect(check).toHaveBeenCalledTimes(1);
    timers.mockRestore();
  });

  it("the bound is above the longest legitimate phase, and the shutdown cap inside the 45 s stop grace", () => {
    expect(SYNC_STALL_AFTER_MS).toBe(120_000);
    expect(SYNC_STALL_CHECK_MS).toBe(5_000);
    expect(SYNC_STALL_REPORT_TIMEOUT_MS).toBe(2_000);
    expect(SYNC_STALL_EXIT_CODE).toBe(70);
    // A slot wait at the largest S, a request, a statement: each well below it.
    const longest = Math.max(
      FANSLY_PAUSE_MAX_MS * SYNC_TAKEOVER_FACTOR,
      REQUEST_TIMEOUT_MS,
      SYNC_POOL_TIMEOUTS.statementTimeoutMs,
      SYNC_POOL_TIMEOUTS.connectionTimeoutMillis,
      SYNC_POOL_TIMEOUTS.lockTimeoutMs,
    );
    expect(longest).toBe(72_000);
    expect(longest).toBeLessThan(SYNC_STALL_AFTER_MS);
    expect(SYNC_POOL_TIMEOUTS).toEqual({
      connectionTimeoutMillis: 30_000,
      statementTimeoutMs: 60_000,
      lockTimeoutMs: 30_000,
      idleInTransactionSessionTimeoutMs: 60_000,
    });
    expect(SYNC_SHUTDOWN_CAP_MS).toBe(40_000);
  });

  it("says in the incident what stalled, where and for how long", () => {
    expect(describeSyncStall({ component: "actor", pageId: 4, generation: "12", phase: "admit", ageMs: 121_400, stale: 1 }))
      .toBe("The sync process stalled: the actor of page 4 (owner generation 12) made no progress for 121 s (phase admit). "
        + "It exited (70) for Docker to restart it; its pages wait for that restart.");
    expect(describeSyncStall({ component: "host", pageId: null, generation: null, phase: "list_pages", ageMs: 125_000, stale: 3 }))
      .toBe("The sync process stalled: the host's mode loop made no progress for 125 s (phase list_pages; 2 more stalled). "
        + "It exited (70) for Docker to restart it; its pages wait for that restart.");
  });
});
