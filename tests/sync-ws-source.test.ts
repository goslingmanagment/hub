import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Database } from "@agency_hub_core/db";
import { fanslyWireSpec, FanslySendRefusedError, safeFanslyAnswerHeaders } from "@agency_hub_core/fansly";

import { bindFanslyUpgradeLease } from "../apps/runtime/src/services/egress/fansly-send-lease.ts";
import { FANSLY_WS_CONNECTION_TIMING } from "../apps/runtime/src/services/fansly-ws/connection.ts";
import { classifyWireOutcome } from "../apps/runtime/src/sync/engine/errors.ts";
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
// check, the transport outcome of a settled Upgrade — whose status and safe
// headers reach the classifier (step 3b ruling 10) — the stop budgets against
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
    expect(await lease.settled).toEqual({ outcome: "response", httpStatus: 101, headers: {} });
  });

  it("maps a settled Upgrade to the transport outcome of design §3.3", () => {
    const sent = { sent: true, refusal: null };
    const unsent = { sent: false, refusal: null };
    expect(upgradeOutcome(sent, { outcome: "response", httpStatus: 101, headers: {} })).toEqual({
      kind: "response", status: 101, headers: {}, bodyText: "", bodyBytes: 0, sendMark: "request_start",
    });
    expect(upgradeOutcome(sent, { outcome: "response", httpStatus: 429, headers: { "retry-after": "600" } }))
      .toMatchObject({ kind: "response", status: 429, headers: { "retry-after": "600" } });
    expect(upgradeOutcome(sent, { outcome: "timeout", httpStatus: null, headers: {} })).toMatchObject({ kind: "timeout", sent: true });
    expect(upgradeOutcome(unsent, { outcome: "transport_error", httpStatus: null, headers: {} }))
      .toMatchObject({ kind: "transport_error", sent: false });
    // The attempt ended before its dispatch reached the check: nothing was
    // sent, and it is no refusal of the pacer.
    expect(upgradeOutcome(unsent, { outcome: "aborted_before_send", httpStatus: null, headers: {} }))
      .toMatchObject({ kind: "transport_error", sent: false });
  });
});

type FakeHandler = Record<string, ((...args: never[]) => unknown) | undefined>;
type FakeDispatch = (options: unknown, handler: FakeHandler) => boolean;
interface FakeDispatcher {
  dispatch: FakeDispatch;
  compose(...interceptors: Array<(next: FakeDispatch) => FakeDispatch>): FakeDispatcher;
}

/** A composable dispatcher stand-in whose base hands the innermost handler to
 *  the test, which plays the origin: `onRequestStart`, then the answer. */
function originDispatcher() {
  const handlers: FakeHandler[] = [];
  const chain = (dispatch: FakeDispatch): FakeDispatcher => ({
    dispatch,
    compose: (...interceptors) => chain(interceptors.reduce((next, interceptor) => interceptor(next), dispatch)),
  });
  const dispatcher = chain((_options, handler) => {
    handlers.push(handler);
    return true;
  });
  return { dispatcher, handlers };
}

const NOW = new Date("2026-10-03T12:00:00.000Z");

/** One Upgrade on the engine lease bound as the receiver socket binds it
 *  (`bindFanslyUpgradeLease`): sent, then answered by `answer`; its settled
 *  outcome as the classifier reads it for `ws.upgrade`. */
async function answeredUpgrade(answer: (handler: FakeHandler, controller: { abort: () => void }) => void) {
  const lease = createEngineUpgradeLease(hooks(() => null), { pageId: 4 });
  const origin = originDispatcher();
  const upstream = { onRequestStart: vi.fn(), onRequestUpgrade: vi.fn(), onResponseStart: vi.fn(), onResponseError: vi.fn() };
  (bindFanslyUpgradeLease(lease, origin.dispatcher as never) as unknown as FakeDispatcher).dispatch({}, upstream);
  const handler = origin.handlers[0]!;
  const controller = { abort: vi.fn() };
  handler.onRequestStart!(controller as never, {} as never);
  expect(lease.sent).toBe(true);
  answer(handler, controller);
  const settled = await lease.settled;
  const outcome = upgradeOutcome(lease, settled);
  if (outcome.kind === "shadow") throw new Error("an Upgrade is never a shadow outcome");
  const classified = classifyWireOutcome(outcome, fanslyWireSpec("ws.upgrade"), {}, { now: NOW });
  return { settled, classified, upstream, controller };
}

describe("the Upgrade's answer reaches the classifier (step 3b ruling 10)", () => {
  it("keeps of an answer only its safe headers: Retry-After and Date by lower-case name, a repeat joined as a REST answer's", () => {
    expect(safeFanslyAnswerHeaders({
      "Retry-After": "600",
      "set-cookie": ["f-s-c=secret; Path=/", "f-s-d=secret"],
      "sec-websocket-accept": "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
      Date: NOW.toUTCString(),
      "x-absent": undefined,
    })).toEqual({ "retry-after": "600", date: NOW.toUTCString() });
    expect(safeFanslyAnswerHeaders({ "retry-after": ["600", "600"] })).toEqual({ "retry-after": "600, 600" });
    expect(safeFanslyAnswerHeaders(null)).toEqual({});
    expect(safeFanslyAnswerHeaders(undefined)).toEqual({});
  });

  it("a 429 with Retry-After: 600 settles with that header alone and is the provider's pace for 600 s; the socket code still sees the whole answer", async () => {
    const answer = { "retry-after": "600", "set-cookie": "f-s-c=secret; Path=/", "content-length": "0" };
    const { settled, classified, upstream, controller } = await answeredUpgrade((handler, at) => {
      handler.onResponseStart!(at as never, 429 as never, answer as never, "Too Many Requests" as never);
    });
    expect(settled).toEqual({ outcome: "response", httpStatus: 429, headers: { "retry-after": "600" } });
    expect(classified).toMatchObject({ errorClass: "rate_limit", httpStatus: 429, retryAfterMs: 600_000 });
    expect(upstream.onResponseStart).toHaveBeenCalledExactlyOnceWith(controller, 429, answer, "Too Many Requests");
  });

  it("an HTTP-date Retry-After is read against the clock", async () => {
    const until = new Date(NOW.getTime() + 900_000).toUTCString();
    const { classified } = await answeredUpgrade((handler, at) => {
      handler.onResponseStart!(at as never, 429 as never, { "retry-after": until } as never, "Too Many Requests" as never);
    });
    expect(classified).toMatchObject({ errorClass: "rate_limit", retryAfterMs: 900_000 });
  });

  it("a 503 naming its Retry-After is the provider's pause; without one it failed the handshake (the socket's ladder)", async () => {
    const paused = await answeredUpgrade((handler, at) => {
      handler.onResponseStart!(at as never, 503 as never, { "retry-after": "120" } as never, "Service Unavailable" as never);
    });
    expect(paused.classified).toMatchObject({ errorClass: "rate_limit", httpStatus: 503, retryAfterMs: 120_000 });
    const failed = await answeredUpgrade((handler, at) => {
      handler.onResponseStart!(at as never, 503 as never, {} as never, "Service Unavailable" as never);
    });
    expect(failed.classified).toMatchObject({ errorClass: "subject_failure", httpStatus: 503, retryAfterMs: null });
    // A 429 without the header still holds (on the default ladder).
    const bare = await answeredUpgrade((handler, at) => {
      handler.onResponseStart!(at as never, 429 as never, {} as never, "Too Many Requests" as never);
    });
    expect(bare.classified).toMatchObject({ errorClass: "rate_limit", retryAfterMs: null });
  });

  it("the 101 and a transport error settle as before: the accepted Upgrade, the network", async () => {
    const upgraded = await answeredUpgrade((handler, at) => {
      handler.onRequestUpgrade!(at as never, 101 as never, { "sec-websocket-accept": "x", "set-cookie": "f-s-c=secret" } as never, {} as never);
    });
    expect(upgraded.settled).toEqual({ outcome: "response", httpStatus: 101, headers: {} });
    expect(upgraded.classified.errorClass).toBe("ok");
    const broken = await answeredUpgrade((handler, at) => {
      handler.onResponseError!(at as never, new Error("socket hang up") as never);
    });
    expect(broken.settled).toEqual({ outcome: "transport_error", httpStatus: null, headers: {} });
    expect(broken.classified.errorClass).toBe("network");
  });

  it("the engine lease settles with the safe headers only, whoever completes it", async () => {
    const lease = createEngineUpgradeLease(hooks(() => null), { pageId: 4 });
    await lease.complete({ outcome: "response", httpStatus: 429, headers: { "retry-after": "60", "set-cookie": "f-s-c=secret" } });
    expect(await lease.settled).toEqual({ outcome: "response", httpStatus: 429, headers: { "retry-after": "60" } });
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
