import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupAdapterHarness,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";
import { createTestFanslySendGuard } from "./helpers/fansly-send-guard.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("Fansly subscribers adapter", () => {
  it("uses the expired total and completes an exact-full expired page", async () => {
    const {
      FanslyAdapter,
      fetchMock,
    } = await loadAdapters();

    fetchMock.mockResolvedValueOnce(toJsonResponse({
      success: true,
      response: {
        stats: {
          total: 39,
          totalActive: 37,
          totalExpired: 2,
        },
        subscriptions: [
          { id: "expired-1", subscriberId: "fan-1", status: 5 },
          { id: "expired-2", subscriberId: "fan-2", status: 5 },
        ],
      },
    }));

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
    });
    const result = await adapter.getSubscribersPage({
      sendGuard: createTestFanslySendGuard(),
      session: {
        authorization: "token",
      },
      proxy: { url: "socks5://proxy.example:1080" },
    }, {
      offset: 0,
      limit: 2,
      status: "5",
    });
    await adapter.close();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("status")).toBe("5");
    expect(result).toMatchObject({
      total: 2,
      offset: 0,
      done: true,
      items: [
        { id: "expired-1" },
        { id: "expired-2" },
      ],
    });
  });
});
