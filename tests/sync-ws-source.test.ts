import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Database } from "@agency_hub_core/db";
import { FanslySendRefusedError } from "@agency_hub_core/fansly";

import { FANSLY_WS_CONNECTION_TIMING } from "../apps/runtime/src/services/fansly-ws/connection.ts";
import { SHUTDOWN_ABORT_BUDGET_MS, SHUTDOWN_ACTOR_BUDGET_MS } from "../apps/runtime/src/sync/engine/host.ts";
import { REQUEST_TIMEOUT_MS } from "../apps/runtime/src/sync/engine/pacer.ts";
import { noopMetrics, systemClock, type SendHooks } from "../apps/runtime/src/sync/engine/ports.ts";
import {
  createEngineUpgradeLease,
  FANSLY_WS_SOURCE_TIMING,
  FanslyWsSource,
  SYNC_WS_APPLY_DRAIN_MS,
  upgradeOutcome,
  wsReconnectDelayMs,
  WS_RECONNECT_CAP_MS,
  WS_RECONNECT_SLOW_MS,
} from "../apps/runtime/src/sync/fansly/ws/source.ts";
import { quietLogger, testConfig } from "./helpers/sync-engine-host.ts";

// The pure parts of the engine's page socket (step-3 design §3.3): the
// reconnect ladder moved from the step-1 receiver, the engine lease that lets
// the step-1 socket code dispatch the Upgrade under the pacer's one-shot
// check, the transport outcome of a settled Upgrade, the stop budgets against
// the container's grace, and a source that refuses a handshake it cannot own.

const read = (file: string) => readFileSync(path.resolve(file), "utf8");

describe("the reconnect ladder", () => {
  it("is the step-1 receiver's: 1.5 s doubling to 60 s, 30 min after ten failures, ±20 %", () => {
    expect(wsReconnectDelayMs(0, 0.5)).toBe(1_500);
    expect(wsReconnectDelayMs(1, 0.5)).toBe(3_000);
    expect(wsReconnectDelayMs(5, 0.5)).toBe(48_000);
    expect(wsReconnectDelayMs(6, 0.5)).toBe(WS_RECONNECT_CAP_MS);
    expect(wsReconnectDelayMs(9, 0.5)).toBe(WS_RECONNECT_CAP_MS);
    expect(wsReconnectDelayMs(10, 0.5)).toBe(WS_RECONNECT_SLOW_MS);
    expect(wsReconnectDelayMs(1, 0)).toBe(2_400);
    expect(wsReconnectDelayMs(1, 1)).toBeCloseTo(3_600, 6);
    expect(wsReconnectDelayMs(1, 7)).toBeCloseTo(3_600, 6);
    expect(wsReconnectDelayMs(2, 0.5, 100)).toBe(400);
  });

  it("is the one ladder: the legacy receiver uses it too", () => {
    const worker = read("apps/runtime/src/services/fansly-ws/worker.ts");
    expect(worker).toContain("await pause(signal, wsReconnectDelayMs(failures, Math.random(), timing.backoffBaseMs));");
    expect(worker).not.toMatch(/30 \* 60_000/);
  });
});

/** A dispatcher stand-in: `compose` wraps a dispatch that starts the request
 *  (undici's `onRequestStart`) unless the controller was aborted. */
function fakeDispatcher() {
  const started: unknown[] = [];
  const aborted: unknown[] = [];
  const dispatcher = {
    compose(interceptor: (dispatch: (options: unknown, handler: Record<string, (...args: unknown[]) => void>) => boolean) =>
      (options: unknown, handler: Record<string, (...args: unknown[]) => void>) => boolean) {
      return {
        dispatch: interceptor((_options, handler) => {
          const controller = { abort: (reason: unknown) => aborted.push(reason) };
          handler.onRequestStart?.(controller, {});
          return true;
        }),
      };
    },
  };
  return { dispatcher, started, aborted };
}

function hooks(check: () => FanslySendRefusedError | null): SendHooks & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    check: () => {
      state.calls += 1;
      return check();
    },
  };
}

describe("the engine's Upgrade lease (G12, E15)", () => {
  it("binds the admission's check once: the first dispatch is sent, a second is refused before a byte", () => {
    const check = hooks(() => null);
    const lease = createEngineUpgradeLease(check, { pageId: 7 });
    const fake = fakeDispatcher();
    const bound = lease.bind(fake.dispatcher as never) as unknown as { dispatch(options: unknown, handler: object): boolean };
    const handler = { onRequestStart: () => fake.started.push("start") };
    bound.dispatch({}, handler);
    expect(lease.sent).toBe(true);
    expect(lease.sendRefused).toBe(false);
    expect(fake.started).toEqual(["start"]);
    bound.dispatch({}, handler);
    expect(fake.started).toEqual(["start"]);
    expect(fake.aborted).toEqual([expect.objectContaining({ reason: "lease_used" })]);
    // The pacer was asked exactly once.
    expect(check.calls).toBe(1);
    expect(lease.pageId).toBe(7);
  });

  it("a refusal of the pacer aborts the dispatch and is the outcome, whatever the completion says", async () => {
    const lease = createEngineUpgradeLease(hooks(() => new FanslySendRefusedError("pace")), { pageId: 7 });
    const fake = fakeDispatcher();
    (lease.bind(fake.dispatcher as never) as unknown as { dispatch(options: unknown, handler: object): boolean })
      .dispatch({}, { onRequestStart: () => fake.started.push("start") });
    expect(fake.started).toEqual([]);
    expect(lease.sent).toBe(false);
    expect(lease.refusal).toBe("pace");
    await lease.complete({ outcome: "transport_error", httpStatus: null });
    expect(upgradeOutcome(lease, await lease.settled)).toEqual({ kind: "aborted_before_send", refusal: "pace" });
  });

  it("settles once, at the first completion", async () => {
    const lease = createEngineUpgradeLease(hooks(() => null), { pageId: 1 });
    await lease.complete({ outcome: "response", httpStatus: 101 });
    await lease.complete({ outcome: "transport_error", httpStatus: null });
    expect(await lease.settled).toEqual({ outcome: "response", httpStatus: 101 });
  });

  it("maps a settled Upgrade to the transport outcome of design §3.3", () => {
    const sent = { sent: true, refusal: null };
    const unsent = { sent: false, refusal: null };
    expect(upgradeOutcome(sent, { outcome: "response", httpStatus: 101 })).toEqual({
      kind: "response", status: 101, headers: {}, bodyText: "", bodyBytes: 0, sendMark: "request_start",
    });
    expect(upgradeOutcome(sent, { outcome: "response", httpStatus: 429 })).toMatchObject({ kind: "response", status: 429 });
    expect(upgradeOutcome(sent, { outcome: "timeout", httpStatus: null })).toMatchObject({ kind: "timeout", sent: true });
    expect(upgradeOutcome(unsent, { outcome: "transport_error", httpStatus: null })).toMatchObject({ kind: "transport_error", sent: false });
    // The attempt ended before its dispatch reached the check: nothing was
    // sent, and it is no refusal of the pacer.
    expect(upgradeOutcome(unsent, { outcome: "aborted_before_send", httpStatus: null }))
      .toMatchObject({ kind: "transport_error", sent: false });
  });
});

describe("the socket source", () => {
  it("drains inside the shutdown budget, which sits inside the container's 45 s stop grace", () => {
    expect(FANSLY_WS_SOURCE_TIMING.drainMs).toBe(FANSLY_WS_CONNECTION_TIMING.drainMs);
    expect(FANSLY_WS_SOURCE_TIMING.applyDrainMs).toBe(SYNC_WS_APPLY_DRAIN_MS);
    expect(SYNC_WS_APPLY_DRAIN_MS).toBe(10_000);
    expect(FANSLY_WS_SOURCE_TIMING.drainMs + FANSLY_WS_SOURCE_TIMING.applyDrainMs).toBeLessThanOrEqual(SHUTDOWN_ACTOR_BUDGET_MS);
    expect(SHUTDOWN_ACTOR_BUDGET_MS + SHUTDOWN_ABORT_BUDGET_MS).toBeLessThan(45_000);
    expect(FANSLY_WS_SOURCE_TIMING.handshakeTimeoutMs).toBe(REQUEST_TIMEOUT_MS);
    expect(FANSLY_WS_SOURCE_TIMING.downListAfterMs).toBe(120_000);
  });

  it("refuses a handshake it holds no socket lock for, without asking the pacer; a stop before the start is immediate", async () => {
    const enqueued: unknown[] = [];
    const source = new FanslyWsSource({
      db: {} as Database,
      config: testConfig("postgres://unused"),
      logger: quietLogger,
      clock: systemClock,
      metrics: noopMetrics,
      connectionString: "postgres://unused",
      pageId: 3,
      pageLabel: "page-3",
      enqueue: async (signals) => {
        enqueued.push(...signals);
      },
    });
    expect(source.state).toBe("idle");
    const check = hooks(() => null);
    expect(await source.handshake(check, new AbortController().signal)).toEqual({ kind: "aborted_before_send", refusal: "lease_inactive" });
    expect(check.calls).toBe(0);
    await source.stop("disabled");
    expect(source.state).toBe("stopped");
    expect(await source.handshake(check, new AbortController().signal)).toEqual({ kind: "aborted_before_send", refusal: "lease_inactive" });
    expect(enqueued).toEqual([]);
  });

  it("is created only for a live slot, started after its actor and stopped before the page's safe release", () => {
    const host = read("apps/runtime/src/sync/engine/host.ts");
    expect(host).toContain('const ws = mode === "live" ? this.#createWsSource(page, generation) : null;');
    const exit = host.slice(host.indexOf("async #onActorExit("));
    expect(exit.indexOf("await slot.ws?.stop(")).toBeGreaterThan(-1);
    expect(exit.indexOf("await slot.ws?.stop(")).toBeLessThan(exit.indexOf("this.#release(slot.pageId, slot.generation)"));
    const acquire = host.slice(host.indexOf("async #acquire("), host.indexOf("async #liveTransport("));
    expect(acquire.indexOf("ws?.start();")).toBeGreaterThan(acquire.indexOf("new SyncActor("));
  });
});
