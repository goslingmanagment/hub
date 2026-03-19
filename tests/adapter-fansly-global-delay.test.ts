import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureEvents,
  cleanupAdapterHarness,
  fanslyAccountResponse,
  fanslyTransactionsResponse,
  loadAdapters,
} from "./helpers/adapter-harness.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("adapter hardening", () => {
  it("serializes Fansly requests from different categories behind the global delay", async () => {
    const {
      FanslyAdapter,
      fetchMock,
    } = await loadAdapters();
    const { events, requestObserver } = captureEvents();

    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const pathname = new URL(String(args[0])).pathname;
      if (pathname === "/account/me") {
        return fanslyAccountResponse();
      }

      if (pathname === "/account/wallets/earnings/transactions") {
        return fanslyTransactionsResponse();
      }

      throw new Error(`Unexpected URL ${String(args[0])}`);
    });

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 5,
    });
    const context = {
      session: {
        authorization: "token",
      },
      requestObserver,
    };

    await adapter.getAccountMe(context);
    await adapter.getTransactionsPage(context, {
      limit: 1,
      offset: 0,
    });

    const startedEvents = events.filter((event) => event.state === "started");
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents[0]?.rateLimitWaitMs).toBeNull();
    expect(Number(startedEvents[1]?.rateLimitWaitMs)).toBeGreaterThanOrEqual(100);
    expect(
      new Date(String(startedEvents[1]?.timestamp)).getTime() -
      new Date(String(startedEvents[0]?.timestamp)).getTime(),
    ).toBeGreaterThanOrEqual(100);
    expect(events.some((event) => event.state === "retry")).toBe(false);
  });

  it("skips in-memory serialization when a shared DB waiter is present", async () => {
    const {
      FanslyAdapter,
    } = await loadAdapters();
    const waiter = vi.fn(async () => {});

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 5,
    });
    const waitMs = await (adapter as any).waitForRateLimit({
      proxy: null,
      rateLimitWaiter: waiter,
    }, "transactions", 0);

    expect(waitMs).toBe(0);
    expect(waiter).toHaveBeenCalledWith([
      { provider: "fansly", scope: "global" },
    ]);
  });

  it("keeps fallback pacing scoped to the current egress", async () => {
    const {
      FanslyAdapter,
    } = await loadAdapters();

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 5,
    });

    await (adapter as any).waitForRateLimit({
      proxy: null,
    }, "account", 0);
    const waitMs = await (adapter as any).waitForRateLimit({
      proxy: {
        url: "socks5://proxy-b.example",
      },
    }, "account", 0);

    expect(waitMs).toBe(0);
  });
});
