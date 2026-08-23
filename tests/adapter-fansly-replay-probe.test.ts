import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupAdapterHarness,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("Fansly adapter Stage 6 replay-probe methods", () => {
  it("build correct URLs/queries/headers, and omit optional params when unset", async () => {
    const { FanslyAdapter, fetchMock } = await loadAdapters();

    fetchMock
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: [] }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: [] }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: [] }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: [] }));

    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
    const context = {
      session: {
        authorization: "token-abc",
        fanslyClientId: "client-1",
        fanslyClientCheck: "check-1",
        fanslySessionId: "session-1",
        routeChecks: {
          earnings: "check-earnings",
          media: "check-media",
        },
      },
      proxy: { url: "socks5://proxy.example:1080" },
      rateLimitWaiter: vi.fn(async () => 0),
    };

    const after = new Date("2026-01-01T00:00:00.000Z");
    const before = new Date("2026-07-01T00:00:00.000Z");

    await adapter.getEarningsStatsAccountsPage(context, {
      correlationAccountId: "fan-9",
      after,
      before,
    });
    await adapter.getEarningsMonthlyStatsAccountsPage(context, {
      correlationAccountId: "fan-9",
      after,
      before,
    });
    await adapter.getMediaOrderHistoryPage(context, {
      accountIds: "fan-9",
      accountMediaId: "media-3",
      before: "order-100",
      limit: 100,
    });
    // Bare order-history call: optional query params must be omitted, call still fires.
    await adapter.getMediaOrderHistoryPage(context, {});
    await adapter.close();

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    const headers = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>);

    expect(urls[0]?.pathname).toBe("/account/wallets/earnings/stats/accounts");
    expect(urls[0]?.searchParams.get("correlationAccountId")).toBe("fan-9");
    expect(urls[0]?.searchParams.get("after")).toBe(String(after.getTime()));
    expect(urls[0]?.searchParams.get("before")).toBe(String(before.getTime()));

    expect(urls[1]?.pathname).toBe("/account/wallets/earnings/monthlystats/accounts");
    expect(urls[1]?.searchParams.get("correlationAccountId")).toBe("fan-9");

    expect(urls[2]?.pathname).toBe("/media/orderhistory");
    expect(urls[2]?.searchParams.get("accountIds")).toBe("fan-9");
    expect(urls[2]?.searchParams.get("accountMediaId")).toBe("media-3");
    expect(urls[2]?.searchParams.get("before")).toBe("order-100");
    expect(urls[2]?.searchParams.get("limit")).toBe("100");

    expect(urls[3]?.pathname).toBe("/media/orderhistory");
    expect(urls[3]?.searchParams.has("accountIds")).toBe(false);
    expect(urls[3]?.searchParams.has("accountMediaId")).toBe(false);
    expect(urls[3]?.searchParams.has("accountMediaBundleId")).toBe(false);
    expect(urls[3]?.searchParams.has("before")).toBe(false);

    for (const header of headers) {
      expect(header.authorization).toBe("token-abc");
      expect(header["fansly-session-id"]).toBe("session-1");
    }
    expect(headers.map((header) => header["fansly-client-check"])).toEqual([
      "check-earnings",
      "check-earnings",
      "check-media",
      "check-media",
    ]);
  });
});
