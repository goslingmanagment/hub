import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FanslySendGuard, FanslySendLease } from "@agency_hub_core/fansly";
import type { runWithHttpRequestSignal as RunWithHttpRequestSignal } from "@agency_hub_core/shared";

import type * as SendGuardModule from "../packages/fansly/src/send-guard.ts";

import {
  captureEvents,
  cleanupAdapterHarness,
  fanslyAccountResponse,
  fanslyFollowersResponse,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";
import {
  createTestFanslySendGuards,
  globalTimersFanslySendGuardClock,
  InMemoryFanslySendGuardStore,
} from "./helpers/fansly-send-guard.ts";

// Plan §2.5 step 1, adapter side: every physical attempt is admitted by the
// page's send guard, dispatched through the lease's own dispatcher with
// redirects off, and completed on every path. The guard is the ONLY pacing of
// a Fansly request (plan §2.3, §2.5 p.4): no endpoint pause for messages, the
// chat list or followers, no in-memory chain, no `global` scope, no +100 ms.

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

/** A guard that records its admissions. */
function recordingGuard(inner: FanslySendGuard, order: string[]): FanslySendGuard {
  return {
    async acquire(input) {
      order.push(`capture:${input.operation}`);
      return inner.acquire(input);
    },
  };
}

describe("the adapter under the per-page send guard", () => {
  it("captures the page for every attempt, the SDK retry included", async () => {
    harness.fetchMock
      .mockResolvedValueOnce(toJsonResponse({ success: false }, { status: 503 }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: { messages: [] } }));
    const order: string[] = [];
    const { registry, store } = guards();
    vi.useFakeTimers();
    const request = adapter().getMessagesPage({
      session,
      proxy,
      sendGuard: recordingGuard(registry.forPage(7, "sync_stream"), order),
    }, { groupId: "group-1", limit: 25 });
    await vi.runAllTimersAsync();
    await request;

    // The retry is a new attempt: a new capture, and nothing else before it.
    expect(order).toEqual(["capture:messages", "capture:messages"]);
    expect(store.journal.map((row) => [row.pageId, row.outcome, row.httpStatus])).toEqual([
      [7, "response", 503],
      [7, "response", 200],
    ]);
  });

  it("paces messages, the chat list and followers by the guard alone: S × (1 + u), no endpoint pause", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    harness.fetchMock.mockImplementation(async (...args: unknown[]) => {
      const path = new URL(String(args[0])).pathname;
      if (path.endsWith("/messaging/groups")) {
        return toJsonResponse({ success: true, response: { data: [], aggregationData: { groups: [], accounts: [] } } });
      }
      if (path.includes("/followersnew")) return fanslyFollowersResponse();
      return toJsonResponse({ success: true, response: { messages: [] } });
    });
    // u = draw × 0.2 is drawn at each completion and spaces the next send.
    const draws = [0, 0.625, 0.3125, 0.9375, 0.5, 0];
    const store = new InMemoryFanslySendGuardStore(() => Date.now(), true);
    const { registry } = createTestFanslySendGuards({
      store,
      settingMs: 2_000,
      random: () => draws.shift() ?? 0,
      clock: globalTimersFanslySendGuardClock,
    });
    const { events, requestObserver } = captureEvents();
    const context = { session, proxy, requestObserver, sendGuard: registry.forPage(7, "sync_stream") };
    const fansly = adapter();
    const sequence = [
      () => fansly.getMessagesPage(context, { groupId: "group-1", limit: 25 }),
      () => fansly.getMessagesPage(context, { groupId: "group-2", limit: 25 }),
      () => fansly.getMessagesPage(context, { groupId: "group-3", limit: 25 }),
      () => fansly.getMessagingGroupsPage(context, { offset: 0, limit: 25 }),
      () => fansly.getFollowersPage(context, "acct-1", { offset: 0, limit: 100 }),
      () => fansly.getMessagesPage(context, { groupId: "group-4", limit: 25 }),
    ];
    for (const next of sequence) {
      const request = next();
      await vi.runAllTimersAsync();
      await request;
    }

    const started = events
      .filter((event) => event.state === "started")
      .map((event) => new Date(String(event.timestamp)).getTime());
    const gaps = started.slice(1).map((at, index) => at - started[index]!);
    // S × (1 + u) from the previous completion (instant here), u = 0, 0.125,
    // 0.0625, 0.1875, 0.1: never the retired 7500 / 5000 ms endpoint pauses.
    const expected = [2_000, 2_250, 2_125, 2_375, 2_200];
    expect(gaps).toHaveLength(expected.length);
    gaps.forEach((gap, index) => {
      expect(gap).toBeGreaterThanOrEqual(expected[index]!);
      expect(gap).toBeLessThanOrEqual(expected[index]! + 1);
    });
    expect(store.journal.map((row) => row.operation)).toEqual([
      "messages", "messages", "messages", "messaging_groups", "followers", "messages",
    ]);
    expect(store.journal.every((row) => row.settingMs === 2_000)).toBe(true);
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
