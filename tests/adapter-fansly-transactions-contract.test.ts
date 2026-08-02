import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupAdapterHarness,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("Fansly transaction page contract", () => {
  it("preserves raw drift without dereferencing malformed totals or data", async () => {
    const { FanslyAdapter, fetchMock } = await loadAdapters();
    const missingTotal = { data: [] };
    const unsafeTotal = { total: Number.MAX_SAFE_INTEGER + 1, data: [] };
    const missingData = { total: 0 };

    fetchMock
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: missingTotal }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: unsafeTotal }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: missingData }));

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 0,
    });
    const context = {
      session: { authorization: "token" },
      proxy: { url: "socks5://proxy.example:1080" },
      rateLimitWaiter: vi.fn(async () => 0),
    };

    const results = [
      await adapter.getTransactionsPage(context, { offset: 0, limit: 100 }),
      await adapter.getTransactionsPage(context, { offset: 100, limit: 100 }),
      await adapter.getTransactionsPage(context, { offset: 200, limit: 100 }),
    ];
    await adapter.close();

    expect(results).toEqual([
      {
        total: null,
        items: [],
        offset: 0,
        done: false,
        contractAccepted: false,
        raw: missingTotal,
      },
      {
        total: null,
        items: [],
        offset: 100,
        done: false,
        contractAccepted: false,
        raw: unsafeTotal,
      },
      {
        total: null,
        items: [],
        offset: 200,
        done: false,
        contractAccepted: false,
        raw: missingData,
      },
    ]);
  });
});
