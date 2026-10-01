import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FanslySendGuard, FanslySendLease } from "@agency_hub_core/fansly";
import type { runWithHttpRequestSignal as RunWithHttpRequestSignal } from "@agency_hub_core/shared";

import type * as SendGuardModule from "../packages/fansly/src/send-guard.ts";

import {
  captureEvents,
  cleanupAdapterHarness,
  fanslyAccountResponse,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";
import {
  createTestFanslySendGuards,
  globalTimersFanslySendGuardClock,
  InMemoryFanslySendGuardStore,
} from "./helpers/fansly-send-guard.ts";

// Plan §2.5 step 1, adapter side: every physical attempt is admitted by the
// page's send guard AFTER the legacy endpoint pauses, dispatched through the
// lease's own dispatcher with redirects off, and completed on every path.
// The page-wide spacing is the guard's: no in-memory `global` chain, no
// `global` limiter scope, no +100 ms.

let harness: Awaited<ReturnType<typeof loadAdapters>>;
let sendGuardModule: typeof SendGuardModule;
let runWithHttpRequestSignal: typeof RunWithHttpRequestSignal;

beforeAll(async () => {
  harness = await loadAdapters();
  sendGuardModule = await import("../packages/fansly/src/send-guard.ts");
  ({ runWithHttpRequestSignal } = await import("@agency_hub_core/shared"));
});

beforeEach(() => {
  harness.fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  cleanupAdapterHarness();
});

const session = { authorization: "token" };
const proxy = { url: "socks5://proxy.example:1080" };

function adapter() {
  return new harness.FanslyAdapter({ baseUrl: "https://fansly.example" });
}

function guards(settingMs = 0) {
  const store = new InMemoryFanslySendGuardStore(() => Date.now(), true);
  return createTestFanslySendGuards({
    store,
    settingMs,
    random: () => 0,
    clock: globalTimersFanslySendGuardClock,
  });
}

/** A guard that records the order of admissions against the endpoint waiter. */
function recordingGuard(inner: FanslySendGuard, order: string[]): FanslySendGuard {
  return {
    async acquire(input) {
      order.push(`capture:${input.operation}`);
      return inner.acquire(input);
    },
  };
}

describe("the adapter under the per-page send guard", () => {
  it("reserves the endpoint pause first, then captures the page, for every attempt", async () => {
    harness.fetchMock
      .mockResolvedValueOnce(toJsonResponse({ success: false }, { status: 503 }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: { messages: [] } }));
    const order: string[] = [];
    const waiter = vi.fn(async (scopes: Array<{ scope: string }>) => {
      order.push(`endpoint:${scopes.map((scope) => scope.scope).join(",")}`);
      return 0;
    });
    const { registry, store } = guards();
    vi.useFakeTimers();
    const request = adapter().getMessagesPage({
      session,
      proxy,
      rateLimitWaiter: waiter,
      sendGuard: recordingGuard(registry.forPage(7, "sync_stream"), order),
    }, { groupId: "group-1", limit: 25 });
    await vi.runAllTimersAsync();
    await request;

    // The retry is a new attempt: the endpoint pause and a new capture again.
    expect(order).toEqual([
      "endpoint:dm_messages",
      "capture:messages",
      "endpoint:dm_messages",
      "capture:messages",
    ]);
    expect(store.journal.map((row) => [row.pageId, row.outcome, row.httpStatus])).toEqual([
      [7, "response", 503],
      [7, "response", 200],
    ]);
  });

  it("asks the shared limiter for no scope at all outside the endpoint categories", async () => {
    harness.fetchMock.mockResolvedValueOnce(fanslyAccountResponse());
    const waiter = vi.fn(async () => 0);
    const { registry } = guards();
    await adapter().getAccountMe({
      session,
      proxy,
      rateLimitWaiter: waiter,
      sendGuard: registry.forPage(7, "account_me_api"),
    });
    // The page-wide `global` scope (S + 100 ms per egress) is gone.
    expect(waiter).not.toHaveBeenCalled();
  });

  it("paces a page from the previous COMPLETION by S × (1 + u), with no +100 ms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    harness.fetchMock.mockImplementation(async () => fanslyAccountResponse());
    const { registry } = guards(2_500);
    const { events, requestObserver } = captureEvents();
    const context = { session, proxy, requestObserver, sendGuard: registry.forPage(7, "sync_stream") };
    const fansly = adapter();

    await fansly.getAccountMe(context);
    const second = fansly.getAccountMe(context);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);

    const started = events.filter((event) => event.state === "started");
    expect(new Date(String(started[1]?.timestamp)).getTime()
      - new Date(String(started[0]?.timestamp)).getTime()).toBe(2_500);
    expect(started[1]?.rateLimitWaitMs).toBe(2_500);
  });

  it("does not serialize two pages behind one in-memory chain", async () => {
    vi.useFakeTimers();
    harness.fetchMock.mockImplementation(async () => fanslyAccountResponse());
    const { registry } = guards(2_500);
    const fansly = adapter();
    await fansly.getAccountMe({ session, proxy, sendGuard: registry.forPage(1, "sync_stream") });
    await fansly.getAccountMe({ session, proxy, sendGuard: registry.forPage(2, "sync_stream") });
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dispatches through the lease's own dispatcher, with redirects off", async () => {
    harness.fetchMock.mockResolvedValueOnce(fanslyAccountResponse());
    const bound = { label: "bound-by-lease" };
    const bind = vi.fn(() => bound);
    const complete = vi.fn(async () => undefined);
    const lease = { token: "t", pageId: 7, sent: false, sendRefused: false, bind, complete } as unknown as FanslySendLease;
    await adapter().getAccountMe({ session, proxy, sendGuard: { acquire: async () => lease } });

    const init = harness.fetchMock.mock.calls[0]?.[1] as { redirect: string; dispatcher: unknown };
    expect(init.redirect).toBe("manual");
    expect(init.dispatcher).toBe(bound);
    expect(bind).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith({ outcome: "response", httpStatus: 200 });
  });

  it("completes the lease as never sent when an observer refuses the attempt after the capture", async () => {
    const { registry, store } = guards();
    const refusal = new Error("daily budget exhausted");
    await expect(adapter().getAccountMe({
      session,
      proxy,
      sendGuard: registry.forPage(7, "sync_stream"),
      requestObserver: {
        async onRequestEvent(event) {
          if (event.state === "started") throw refusal;
        },
      },
    })).rejects.toBe(refusal);
    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(store.journal.map((row) => row.outcome)).toEqual(["aborted_before_send"]);
    expect(store.rows.get(7)?.holderToken).toBeNull();
    expect(registry.inflightCount).toBe(0);
  });

  it("records a transport failure and a timeout as such", async () => {
    const { registry, store } = guards();
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    harness.fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(timeout);
    await expect(adapter().getAccountMe({
      session,
      proxy,
      sendGuard: registry.forPage(7, "sync_stream"),
      remainingAttempts: () => 1,
    })).rejects.toThrow("fetch failed");
    await expect(adapter().getAccountMe({
      session,
      proxy,
      sendGuard: registry.forPage(7, "sync_stream"),
      remainingAttempts: () => 1,
    })).rejects.toBe(timeout);
    expect(store.journal.map((row) => row.outcome)).toEqual(["transport_error", "timeout"]);
  });

  it("re-captures without backoff when the guard refused the dispatch, and resets no transport", async () => {
    const { registry, store } = guards();
    const refused = new TypeError("fetch failed", {
      cause: new sendGuardModule.FanslySendRefusedError("send_deadline_passed"),
    });
    harness.fetchMock
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(fanslyAccountResponse());
    const { events, requestObserver } = captureEvents();
    const proxyDispatchersBefore = harness.proxyDispatchers.length;

    await adapter().getAccountMe({
      session,
      proxy,
      requestObserver,
      sendGuard: registry.forPage(7, "sync_stream"),
    });

    const retry = events.find((event) => event.state === "retry");
    expect(retry).toMatchObject({ failureKind: "policy", retryDelayMs: 0 });
    // One dispatcher for the proxy, never replaced.
    expect(harness.proxyDispatchers.length - proxyDispatchersBefore).toBe(1);
    expect(store.journal).toHaveLength(2);
  });

  it("releases a capture that resolves after the request was cancelled", async () => {
    const store = new InMemoryFanslySendGuardStore(() => Date.now(), true);
    const { registry } = createTestFanslySendGuards({ store });
    const inner = registry.forPage(7, "sync_stream");
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    let entered!: () => void;
    const acquireEntered = new Promise<void>((resolve) => { entered = resolve; });
    const slowGuard: FanslySendGuard = {
      async acquire(input) {
        entered();
        await captureGate;
        // The capture itself ignores the signal, like a statement in flight.
        return inner.acquire({ ...input, signal: null });
      },
    };
    const controller = new AbortController();
    const reason = new Error("lease lost");
    const request = runWithHttpRequestSignal(controller.signal, () => adapter().getAccountMe({
      session,
      proxy,
      sendGuard: slowGuard,
    }));
    const rejected = expect(request).rejects.toBe(reason);
    await acquireEntered;
    controller.abort(reason);
    await rejected;
    releaseCapture();
    await vi.waitFor(() => {
      expect(store.journal.map((row) => row.outcome)).toEqual(["aborted_before_send"]);
    });
    expect(store.rows.get(7)?.holderToken).toBeNull();
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });
});
