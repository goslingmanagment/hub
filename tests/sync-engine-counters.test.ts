import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as IncidentsModule from "../apps/runtime/src/services/notification-incidents.ts";

const incidents = vi.hoisted(() => ({
  notifySyncEngineIncident: vi.fn(async () => true),
  resolveSyncEngineIncident: vi.fn(async () => ({ status: "unchanged" as const })),
}));
vi.mock("../apps/runtime/src/services/notification-incidents.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof IncidentsModule>()),
  ...incidents,
}));

import {
  ENGINE_COUNTER_MAX_SERIES,
  ENGINE_COUNTERS_FLUSH_MS,
  EngineCounters,
  engineCounterSamples,
  engineCounterSeries,
  startEngineCounterFlush,
} from "../apps/runtime/src/sync/engine/counters.ts";

// The sync process's counters (engine/counters.ts), pure: the series a
// counter and its labels land in (a page, a route, an origin, a resource and
// an error's name folded), the windows a write takes, and the site-journal
// latch the windows judge.

/** A database whose inserts are recorded (or fail). */
function fakeApp(input: { fail?: boolean } = {}) {
  const inserts: unknown[] = [];
  const warnings: string[] = [];
  return {
    inserts,
    warnings,
    app: {
      db: {
        execute: vi.fn(async (statement: unknown) => {
          if (input.fail === true) throw new Error("connection lost");
          inserts.push(statement);
          return { rows: [], rowCount: 0 };
        }),
      } as never,
      logger: { warn: (_obj: object, msg?: string) => void warnings.push(msg ?? "") },
    },
  };
}

beforeEach(() => {
  incidents.notifySyncEngineIncident.mockClear();
  incidents.resolveSyncEngineIncident.mockClear();
});

describe("a counter's series", () => {
  it("keeps the labels of a closed vocabulary, sorted, and folds the rest", () => {
    expect(engineCounterSeries("sync_site_observed_sends")).toBe("counter_sync_site_observed_sends");
    expect(engineCounterSeries("sync_site_observed_commit_failed", { error: "57014" })).toBe("counter_sync_site_observed_commit_failed");
    expect(engineCounterSeries("sync_ws_connections_ended", { pageId: 4, reason: "closed" })).toBe("counter_sync_ws_connections_ended{reason=closed}");
    expect(engineCounterSeries("sync_site_admitted", { origin: "https://fansly.com", route: "account.me" })).toBe("counter_sync_site_admitted");
    expect(engineCounterSeries("sync_alerts", { subKey: "page_stopped", detail: "pace_violation", route: "messages.page" }))
      .toBe("counter_sync_alerts{detail=pace_violation,subKey=page_stopped}");
    // A value never breaks the series' shape.
    expect(engineCounterSeries("sync_browser_events_refused", { reason: "a{b}=c, d" })).toBe("counter_sync_browser_events_refused{reason=a_b__c__d}");
    expect(engineCounterSeries("sync_apply_errors", { kind: "x".repeat(100), local: true })).toBe(`counter_sync_apply_errors{kind=${"x".repeat(48)},local=true}`);
  });
});

describe("the counters' windows", () => {
  it("counts by series and by name; a drain starts again from zero; a restore adds back", () => {
    const counters = new EngineCounters();
    counters.increment("sync_send_refused", { reason: "pace", pageId: 1 });
    counters.increment("sync_send_refused", { reason: "pace", pageId: 2 });
    counters.increment("sync_send_refused", { reason: "lease_used" });
    counters.increment("sync_apply_effect", { effect: "upsert", resource: "posts.page" }, 5);
    counters.increment("sync_apply_effect", { effect: "upsert" }, 0);
    const window = counters.drain();
    expect(Object.fromEntries(window.series)).toEqual({
      "counter_sync_send_refused{reason=pace}": 2,
      "counter_sync_send_refused{reason=lease_used}": 1,
      "counter_sync_apply_effect{effect=upsert}": 5,
    });
    expect(Object.fromEntries(window.totals)).toEqual({ sync_send_refused: 3, sync_apply_effect: 5 });
    expect(engineCounterSamples(window)).toEqual(expect.arrayContaining([
      { metric: "counter_sync_send_refused{reason=pace}", quantile: "p95", valueMs: 2 },
    ]));
    expect(counters.drain().series.size).toBe(0);

    counters.increment("sync_send_refused", { reason: "pace" });
    counters.restore(window);
    expect(counters.drain().series.get("counter_sync_send_refused{reason=pace}")).toBe(3);
  });

  it("past its series bound, a window's new series keep no labels", () => {
    const counters = new EngineCounters();
    for (let index = 0; index < ENGINE_COUNTER_MAX_SERIES; index += 1) counters.increment("sync_browser_frames", { kind: `k${index}` });
    counters.increment("sync_browser_frames", { kind: "one-more" });
    counters.increment("sync_browser_frames", { kind: "k0" });
    const window = counters.drain();
    expect(window.series.get("counter_sync_browser_frames")).toBe(1);
    expect(window.series.get("counter_sync_browser_frames{kind=k0}")).toBe(2);
    expect(window.totals.get("sync_browser_frames")).toBe(ENGINE_COUNTER_MAX_SERIES + 2);
  });
});

describe("the counters' writes", () => {
  it("every five minutes, like the sampler's engine families", () => {
    expect(ENGINE_COUNTERS_FLUSH_MS).toBe(300_000);
  });

  it("writes what counted, opens the site-journal latch while it counts and resolves it after a clean window", async () => {
    vi.useFakeTimers();
    try {
      const { app, inserts } = fakeApp();
      const counters = new EngineCounters();
      const flush = startEngineCounterFlush(app, counters, { intervalMs: 1_000 });
      counters.increment("sync_site_observed_commit_failed", { error: "57014" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(inserts).toHaveLength(1);
      expect(incidents.notifySyncEngineIncident).toHaveBeenCalledWith(app, expect.objectContaining({
        subKey: "site_journal", pageId: null, detail: "sync_site_observed_commit_failed",
      }));
      expect(incidents.resolveSyncEngineIncident).not.toHaveBeenCalled();

      // A quiet window writes nothing and resolves.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(inserts).toHaveLength(1);
      expect(incidents.resolveSyncEngineIncident).toHaveBeenCalledWith(app, expect.objectContaining({ subKey: "site_journal", pageId: null }));

      // The stop writes the last window; its short window resolves nothing.
      incidents.resolveSyncEngineIncident.mockClear();
      counters.increment("sync_send_refused", { reason: "pace" });
      await flush.stop();
      expect(inserts).toHaveLength(2);
      expect(incidents.resolveSyncEngineIncident).not.toHaveBeenCalled();
      // Stopped: no more windows.
      counters.increment("sync_send_refused", { reason: "pace" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(inserts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a latch that did not open is owed: the next window opens it with the count, never resolves it first", async () => {
    vi.useFakeTimers();
    try {
      const { app, inserts, warnings } = fakeApp();
      const counters = new EngineCounters();
      const flush = startEngineCounterFlush(app, counters, { intervalMs: 1_000 });
      incidents.notifySyncEngineIncident.mockResolvedValueOnce(false);
      counters.increment("sync_site_observed_commit_failed", { error: "57014" }, 2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(inserts).toHaveLength(1);
      expect(incidents.notifySyncEngineIncident).toHaveBeenCalledTimes(1);
      expect(warnings).toContain("Fansly sync engine counter alert not opened; the next write opens it");

      // The next window counted nothing: it opens what is owed, resolves nothing.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(inserts).toHaveLength(1);
      expect(incidents.resolveSyncEngineIncident).not.toHaveBeenCalled();
      expect(incidents.notifySyncEngineIncident).toHaveBeenCalledTimes(2);
      expect(incidents.notifySyncEngineIncident).toHaveBeenLastCalledWith(app, expect.objectContaining({
        subKey: "site_journal", detail: "sync_site_observed_commit_failed", errorSummary: expect.stringMatching(/^2 site request/),
      }));

      // Opened: the window after that is clean and resolves.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(incidents.notifySyncEngineIncident).toHaveBeenCalledTimes(2);
      expect(incidents.resolveSyncEngineIncident).toHaveBeenCalledTimes(1);
      await flush.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed write and a latch that did not open count the window once in the next", async () => {
    vi.useFakeTimers();
    try {
      const failing = fakeApp({ fail: true });
      const counters = new EngineCounters();
      const flush = startEngineCounterFlush(failing.app, counters, { intervalMs: 1_000 });
      incidents.notifySyncEngineIncident.mockResolvedValueOnce(false);
      counters.increment("sync_site_observed_commit_failed", {}, 3);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(incidents.notifySyncEngineIncident).toHaveBeenLastCalledWith(failing.app, expect.objectContaining({ errorSummary: expect.stringMatching(/^3 site request/) }));
      expect(incidents.resolveSyncEngineIncident).not.toHaveBeenCalled();
      await flush.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed write puts its counts back into the next window, and the latch is still judged", async () => {
    vi.useFakeTimers();
    try {
      const failing = fakeApp({ fail: true });
      const counters = new EngineCounters();
      const flush = startEngineCounterFlush(failing.app, counters, { intervalMs: 1_000 });
      counters.increment("sync_site_observed_commit_failed");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(failing.warnings).toEqual(["Fansly sync engine counters not written; they count in the next write"]);
      expect(incidents.notifySyncEngineIncident).toHaveBeenCalledTimes(1);
      await flush.stop();
      expect(counters.drain().totals.get("sync_site_observed_commit_failed")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
