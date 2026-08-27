// #239 — a killed capture rewrite leaves a tombstone that says it was killed.
//
// Production run 1 is the whole reason: `capture:backfill --table observations
// --month 2026-07 --execute` was killed on 2026-08-18 when the #87 deploy
// recreated its container, and its `capture_rewrite_runs` row still read
// `verdict = running, completed_at NULL` eight days later. The runbook tells an
// operator to read that table; it was asserting an in-flight run that had not
// existed for a week.
//
// The existing `catch` settles a run that THROWS. A signal is not a throw — its
// default action terminates the process and nothing inside the try/catch runs.

import { describe, expect, it, vi } from "vitest";

// The signal path writes through the GUARDED variant: it may only settle a row
// that is still `running`, so a signal arriving after the walk settled itself
// cannot rewrite a completed run as `failed`.
const settleRunningCaptureRewriteRun = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@agency_hub_core/db", () => ({ settleRunningCaptureRewriteRun }));

const { settleRunOnSignal, SETTLE_ON_SIGNALS } = await import(
  "../apps/runtime/src/services/capture-rewrite/settle-on-signal.ts"
);

function harness() {
  const handlers = new Map<string, Array<() => void>>();
  const exit = vi.fn();
  const app = {
    db: { marker: "db" },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
  const hooks = {
    on: (signal: string, handler: () => void) => {
      handlers.set(signal, [...(handlers.get(signal) ?? []), handler]);
    },
    off: (signal: string, handler: () => void) => {
      handlers.set(signal, (handlers.get(signal) ?? []).filter((one) => one !== handler));
    },
    exit,
  };
  return { handlers, exit, app, hooks };
}

describe("settleRunOnSignal", () => {
  it("settles the ledger row to failed and names the signal", async () => {
    settleRunningCaptureRewriteRun.mockClear();
    const { handlers, exit, app, hooks } = harness();
    settleRunOnSignal(
      app as never,
      { runId: 41, scopeRef: "observations:2026-07", summary: () => ({ referenced: 362_804 }) },
      hooks as never,
    );

    handlers.get("SIGTERM")?.[0]?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(settleRunningCaptureRewriteRun).toHaveBeenCalledWith(app.db, {
      id: 41,
      verdict: "failed",
      summary: { referenced: 362_804, killedBySignal: "SIGTERM" },
    });
    // 128 + 15: a killed process must not look successful to its launcher.
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("reads the summary AT THE MOMENT of the signal, not when it was armed", async () => {
    settleRunningCaptureRewriteRun.mockClear();
    const { handlers, exit, app, hooks } = harness();
    const progress = { referenced: 0 };
    settleRunOnSignal(
      app as never,
      { runId: 1, scopeRef: "s", summary: () => ({ ...progress }) },
      hooks as never,
    );
    progress.referenced = 359_000;

    handlers.get("SIGINT")?.[0]?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(settleRunningCaptureRewriteRun).toHaveBeenCalledWith(app.db, {
      id: 1,
      verdict: "failed",
      summary: { referenced: 359_000, killedBySignal: "SIGINT" },
    });
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("arms both SIGTERM and SIGINT, and stopRequested tells the walk to stop", async () => {
    settleRunningCaptureRewriteRun.mockClear();
    const { handlers, exit, app, hooks } = harness();
    const guard = settleRunOnSignal(
      app as never,
      { runId: 1, scopeRef: "s", summary: () => ({}) },
      hooks as never,
    );
    for (const signal of SETTLE_ON_SIGNALS) {
      expect(handlers.get(signal)).toHaveLength(1);
    }
    expect(guard.stopRequested()).toBe(false);
    handlers.get("SIGTERM")?.[0]?.();
    expect(guard.stopRequested()).toBe(true);
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  });

  it("settles ONCE however many signals arrive", async () => {
    settleRunningCaptureRewriteRun.mockClear();
    const { handlers, exit, app, hooks } = harness();
    settleRunOnSignal(
      app as never,
      { runId: 7, scopeRef: "s", summary: () => ({}) },
      hooks as never,
    );
    handlers.get("SIGTERM")?.[0]?.();
    handlers.get("SIGTERM")?.[0]?.();
    handlers.get("SIGINT")?.[0]?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(settleRunningCaptureRewriteRun).toHaveBeenCalledTimes(1);
  });

  it("leaves a run that already settled itself ALONE, and says so", async () => {
    // The guarded UPDATE matched no row: the walk got there first. Inventing a
    // `failed` verdict for a run that completed is a worse lie than the stale
    // `running` row this whole mechanism exists to prevent.
    settleRunningCaptureRewriteRun.mockClear();
    settleRunningCaptureRewriteRun.mockResolvedValueOnce(false);
    const { handlers, exit, app, hooks } = harness();
    settleRunOnSignal(
      app as never,
      { runId: 3, scopeRef: "s", summary: () => ({}) },
      hooks as never,
    );
    handlers.get("SIGTERM")?.[0]?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(app.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 3, signal: "SIGTERM" }),
      expect.stringContaining("already settled itself"),
    );
    expect(app.logger.error).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("still exits when the settle itself fails, and says the row stayed `running`", async () => {
    settleRunningCaptureRewriteRun.mockClear();
    settleRunningCaptureRewriteRun.mockRejectedValueOnce(new Error("connection terminated"));
    const { handlers, exit, app, hooks } = harness();
    settleRunOnSignal(
      app as never,
      { runId: 9, scopeRef: "s", summary: () => ({}) },
      hooks as never,
    );
    handlers.get("SIGTERM")?.[0]?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(app.logger.error).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("release() removes the handlers so a later signal is the process's own business", () => {
    const { handlers, app, hooks } = harness();
    const guard = settleRunOnSignal(
      app as never,
      { runId: 1, scopeRef: "s", summary: () => ({}) },
      hooks as never,
    );
    guard.release();
    for (const signal of SETTLE_ON_SIGNALS) {
      expect(handlers.get(signal)).toHaveLength(0);
    }
  });
});
