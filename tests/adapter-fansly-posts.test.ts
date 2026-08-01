import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupAdapterHarness,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("Fansly posts adapter", () => {
  it("uses account timeline cursors and preserves drifted raw pages", async () => {
    const { FanslyAdapter, fetchMock } = await loadAdapters();
    fetchMock
      .mockResolvedValueOnce(toJsonResponse({
        success: true,
        response: {
          posts: [
            {
              id: "881547312038436864",
              accountId: "772956494390898689",
              content: "first post",
              createdAt: 1_771_671_617,
              attachments: [],
            },
            {
              id: "881340289321549825",
              accountId: "772956494390898689",
              content: "older post",
              createdAt: 1_771_622_259,
              attachments: [{ contentType: 2, contentId: "media-1" }],
            },
          ],
          accountMedia: [{ id: "media-1" }],
        },
      }))
      .mockResolvedValueOnce(toJsonResponse({
        success: true,
        response: { timelineItems: [] },
      }));

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 0,
    });
    const context = {
      session: { authorization: "token" },
      proxy: { url: "socks5://proxy.example:1080" },
      rateLimitWaiter: vi.fn(async () => 0),
    };
    const page = await adapter.getPostsPage(context, "772956494390898689", {
      before: "900000000000000000",
      pageIndex: 2,
    });
    const drifted = await adapter.getPostsPage(context, "772956494390898689");
    await adapter.close();

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/timelinenew/772956494390898689");
    expect(url.searchParams.get("before")).toBe("900000000000000000");
    expect(url.searchParams.get("after")).toBe("0");
    expect(url.searchParams.has("wallId")).toBe(false);
    expect(page).toMatchObject({
      contractAccepted: true,
      done: false,
      nextBefore: "881340289321549825",
    });
    expect(page.items).toHaveLength(2);
    expect(page.raw).toMatchObject({ accountMedia: [{ id: "media-1" }] });
    expect(drifted).toMatchObject({ contractAccepted: false, items: [] });
    expect(drifted.raw).toEqual({ timelineItems: [] });
  });
});
