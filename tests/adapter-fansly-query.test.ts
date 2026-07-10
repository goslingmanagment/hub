import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupAdapterHarness,
  fanslyTransactionsResponse,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("Fansly adapter query serialization", () => {
  it("preserves zero offset and limit query params across paginated endpoints", async () => {
    const {
      FanslyAdapter,
      fetchMock,
    } = await loadAdapters();

    fetchMock
      .mockResolvedValueOnce(fanslyTransactionsResponse())
      .mockResolvedValueOnce(toJsonResponse({
        success: true,
        response: {
          stats: {
            total: 0,
            totalActive: 0,
          },
          subscriptions: [],
        },
      }))
      .mockResolvedValueOnce(toJsonResponse({
        success: true,
        response: {
          totalGross: 0,
          totalNet: 0,
          accountId: "acct-1",
          correlationAccountId: null,
        },
      }))
      .mockResolvedValueOnce(toJsonResponse({
        success: true,
        response: {
          followers: [],
          aggregationData: {
            accounts: [],
          },
        },
      }))
      .mockResolvedValueOnce(toJsonResponse({
        success: true,
        response: {
          data: [],
          aggregationData: {
            total: 0,
            accounts: [],
            groups: [],
          },
        },
      }))
      .mockResolvedValueOnce(toJsonResponse({
        success: true,
        response: {
          messages: [],
        },
      }));

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 0,
    });
    const context = {
      session: {
        authorization: "token",
      },
      proxy: { url: "socks5://proxy.example:1080" },
      rateLimitWaiter: vi.fn(async () => 0),
    };

    await adapter.getTransactionsPage(context, {
      offset: 0,
      limit: 0,
    });
    await adapter.getSubscribersPage(context, {
      offset: 0,
      limit: 0,
    });
    await adapter.getEarningsAccountsPage(context, {
      after: new Date("2026-03-01T00:00:00.000Z"),
      before: new Date("2026-03-08T00:00:00.000Z"),
    });
    await adapter.getFollowersPage(context, "acct-1", {
      offset: 0,
      limit: 0,
      lastSeenAfter: 1_775_000_000_000,
    });
    await adapter.getMessagingGroupsPage(context, {
      offset: 0,
      limit: 0,
    });
    await adapter.getMessagesPage(context, {
      groupId: "group-1",
      limit: 0,
    });
    await adapter.close();

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls[0]?.searchParams.get("offset")).toBe("0");
    expect(urls[0]?.searchParams.get("limit")).toBe("0");
    expect(urls[1]?.searchParams.get("offset")).toBe("0");
    expect(urls[1]?.searchParams.get("limit")).toBe("0");
    expect(urls[2]?.pathname).toBe("/account/wallets/earnings/accounts");
    expect(urls[2]?.searchParams.get("after")).toBe(String(new Date("2026-03-01T00:00:00.000Z").getTime()));
    expect(urls[2]?.searchParams.get("before")).toBe(String(new Date("2026-03-08T00:00:00.000Z").getTime()));
    expect(urls[3]?.searchParams.get("offset")).toBe("0");
    expect(urls[3]?.searchParams.get("limit")).toBe("0");
    expect(urls[3]?.searchParams.get("lastSeenAfter")).toBe("1775000000000");
    expect(urls[4]?.searchParams.get("offset")).toBe("0");
    expect(urls[4]?.searchParams.get("limit")).toBe("0");
    expect(urls[5]?.searchParams.get("limit")).toBe("0");
  });

});
