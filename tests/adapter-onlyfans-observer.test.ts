import { afterEach, describe, expect, it } from "vitest";

import {
  captureEvents,
  cleanupAdapterHarness,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("adapter hardening", () => {
  it("emits retry and success observer events for OnlyFans cursor pagination without leaking secrets", async () => {
    const {
      OnlyFansAdapter,
      fetchMock,
    } = await loadAdapters();
    const { events, requestObserver } = captureEvents();

    fetchMock
      .mockResolvedValueOnce(toJsonResponse({ error: "rate limited" }, {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "0.001",
        },
      }))
      .mockResolvedValueOnce(toJsonResponse({
        items: [{
          id: "txn-1",
          amount: 12.5,
          fan: { id: "fan-1" },
          type: "tip",
          status: "posted",
          timestamp: "2026-03-10T12:00:00.000Z",
        }],
        cursor: "next-secret-cursor",
      }));

    const adapter = new OnlyFansAdapter({
      baseUrl: "https://onlyfans.example",
      defaultDelayMs: 0,
    });

    await adapter.getTransactionsPage({
      auth: {
        token: "om-super-secret-token",
      },
      requestObserver,
    }, "platform-account-secret", {
      start: new Date("2026-03-10T00:00:00.000Z"),
      end: new Date("2026-03-11T00:00:00.000Z"),
      cursor: "cursor-secret-123",
      limit: 50,
      pageIndex: 3,
    });

    expect(events.map((event) => [event.state, event.attemptNumber])).toEqual([
      ["started", 1],
      ["retry", 1],
      ["started", 2],
      ["success", 2],
    ]);
    expect(events[0]).toMatchObject({
      operation: "onlymonster_transactions",
      endpointTemplate: "/api/v0/platforms/onlyfans/accounts/:platformAccountId/transactions",
      pagination: {
        pageIndex: 3,
        cursorPresent: true,
      },
      requestMetadata: {
        cursorPresent: true,
        limit: 50,
      },
    });
    expect(events[1]).toMatchObject({
      state: "retry",
      httpStatus: 429,
      retryDelayMs: 1,
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("platform-account-secret");
    expect(serialized).not.toContain("cursor-secret-123");
    expect(serialized).not.toContain("next-secret-cursor");
    expect(serialized).not.toContain("om-super-secret-token");
    await adapter.close();
  });

});
