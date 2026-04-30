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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));

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
    const delayedRequest = adapter.getTransactionsPage(context, {
      limit: 1,
      offset: 0,
    });
    await vi.advanceTimersByTimeAsync(105);
    await delayedRequest;

    const startedEvents = events.filter((event) => event.state === "started");
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents[0]?.rateLimitWaitMs).toBeNull();
    expect(startedEvents[1]?.rateLimitWaitMs).toBe(105);
    expect(
      new Date(String(startedEvents[1]?.timestamp)).getTime() -
      new Date(String(startedEvents[0]?.timestamp)).getTime(),
    ).toBe(105);
    expect(events.some((event) => event.state === "retry")).toBe(false);
  });

  it("skips in-memory serialization when a shared DB waiter is present", async () => {
    const {
      FanslyAdapter,
    } = await loadAdapters();
    const waiter = vi.fn(async () => 275);

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 5,
    });
    const waitMs = await (adapter as any).waitForRateLimit({
      proxy: null,
      rateLimitWaiter: waiter,
    }, "transactions", 0);

    expect(waitMs).toBe(275);
    expect(waiter).toHaveBeenCalledWith([
      { provider: "fansly", scope: "global" },
    ]);
  });

  it("propagates shared DM wait times into request observer events", async () => {
    vi.resetModules();

    const sharedModule = await import("@agency_hub_core/shared");
    vi.spyOn(sharedModule, "executeObservedRequest").mockImplementation(async (input) => {
      const rateLimitWaitMs = await input.waitForRateLimit?.() ?? 0;
      await input.observer?.onRequestEvent({
        state: "started",
        requestId: input.requestId,
        operation: input.operation,
        endpointTemplate: input.endpointTemplate,
        method: input.method,
        attemptNumber: 1,
        timestamp: new Date("2026-03-10T00:00:00.000Z"),
        pagination: input.pagination ?? null,
        requestMetadata: input.requestMetadata,
        rateLimitWaitMs,
      });
      return {
        parsed: {
          messages: [],
        },
        raw: {
          messages: [],
        },
      };
    });

    const { FanslyAdapter } = await import("../packages/fansly/src/adapter.ts");
    const { events, requestObserver } = captureEvents();
    const waiter = vi.fn(async () => 7_500);

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 5,
    });

    await adapter.getMessagesPage({
      session: {
        authorization: "token",
      },
      requestObserver,
      rateLimitWaiter: waiter,
    }, {
      groupId: "group-1",
      limit: 25,
    });
    await adapter.close();

    const startedEvent = events.find((event) => event.state === "started");
    expect(startedEvent?.rateLimitWaitMs).toBe(7_500);
    expect(waiter).toHaveBeenCalledWith([
      { provider: "fansly", scope: "global" },
      { provider: "fansly", scope: "dm_messages" },
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
