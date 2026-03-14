import { afterEach, describe, expect, it } from "vitest";

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
});
