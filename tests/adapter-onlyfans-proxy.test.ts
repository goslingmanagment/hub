import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureEvents,
  cleanupAdapterHarness,
  loadAdapters,
  onlyFansAccountsResponse,
} from "./helpers/adapter-harness.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("adapter hardening", () => {
  it("reuses the OnlyFans proxy dispatcher and enforces same-category pacing", async () => {
    const {
      OnlyFansAdapter,
      createProxyRequestDispatcher,
      directDispatchers,
      fetchMock,
      proxyDispatchers,
    } = await loadAdapters();
    const { events, requestObserver } = captureEvents();

    fetchMock.mockImplementation(async () => onlyFansAccountsResponse());

    const adapter = new OnlyFansAdapter({
      baseUrl: "https://onlyfans.example",
      defaultDelayMs: 25,
    });
    const context = {
      auth: {
        token: "om-token",
      },
      proxy: {
        url: "http://proxy.example:8080",
      },
      requestObserver,
    };

    await adapter.listAccountsPage(context, {
      pageIndex: 0,
    });
    await adapter.listAccountsPage(context, {
      pageIndex: 1,
    });
    await adapter.close();

    const startedEvents = events.filter((event) => event.state === "started");
    expect(startedEvents).toHaveLength(2);
    expect(Number(startedEvents[1]?.rateLimitWaitMs)).toBeGreaterThanOrEqual(15);
    expect(
      new Date(String(startedEvents[1]?.timestamp)).getTime() -
      new Date(String(startedEvents[0]?.timestamp)).getTime(),
    ).toBeGreaterThanOrEqual(15);
    expect(createProxyRequestDispatcher).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      dispatcher: proxyDispatchers[0],
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      dispatcher: proxyDispatchers[0],
    });
    expect(proxyDispatchers[0]?.close).toHaveBeenCalled();
    expect(directDispatchers[0]?.close).toHaveBeenCalled();
  });

  it("skips in-memory fallback pacing when a shared DB waiter is present", async () => {
    const {
      OnlyFansAdapter,
    } = await loadAdapters();
    const waiter = vi.fn(async () => 125);

    const adapter = new OnlyFansAdapter({
      baseUrl: "https://onlyfans.example",
      defaultDelayMs: 25,
    });
    const waitMs = await (adapter as any).waitForRateLimit({
      auth: {
        token: "om-token",
      },
      proxy: {
        url: "http://proxy.example:8080",
      },
      rateLimitWaiter: waiter,
    }, "accounts", 25);

    expect(waitMs).toBe(125);
    expect(waiter).toHaveBeenCalledWith([
      { provider: "onlyfans", scope: "global" },
    ]);
  });
});
