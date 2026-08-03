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
  it("captures account timeline pages and post tips with fail-closed raw contracts", async () => {
    const { FanslyAdapter, fetchMock } = await loadAdapters();
    const rawTips = [
      {
        id: "tip-1",
        senderId: "fan-1",
        receiverId: "creator-1",
        amount: 25_000,
        message: "happy birthday",
        senderTransactionId: "sender-tx-1",
        receiverTransactionId: "receiver-tx-1",
        targets: [{ id: "post-1", type: 1_000 }],
        createdAt: 1_775_000_000,
        tipGoalId: "goal-1",
      },
    ];
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
      }))
      .mockResolvedValueOnce(toJsonResponse({
        success: true,
        response: rawTips,
      }))
      .mockResolvedValueOnce(toJsonResponse({
        success: true,
        response: { tips: rawTips },
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
    const acceptedTips = await adapter.getTipsByTargetIds(context, ["post-1", "post-2"]);
    const driftedTips = await adapter.getTipsByTargetIds(context, ["post-1"]);
    await adapter.close();

    const timelineUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(timelineUrl.pathname).toBe("/timelinenew/772956494390898689");
    expect(timelineUrl.searchParams.get("before")).toBe("900000000000000000");
    expect(timelineUrl.searchParams.get("after")).toBe("0");
    expect(timelineUrl.searchParams.has("wallId")).toBe(false);
    expect(page).toMatchObject({
      contractAccepted: true,
      done: false,
      nextBefore: "881340289321549825",
    });
    expect(page.items).toHaveLength(2);
    expect(page.raw).toMatchObject({ accountMedia: [{ id: "media-1" }] });
    expect(drifted).toMatchObject({ contractAccepted: false, items: [] });
    expect(drifted.raw).toEqual({ timelineItems: [] });
    const tipsUrl = new URL(String(fetchMock.mock.calls[2]?.[0]));
    expect(tipsUrl.pathname).toBe("/tips");
    expect(tipsUrl.searchParams.get("targetIds")).toBe("post-1,post-2");
    expect(acceptedTips).toEqual({
      items: rawTips,
      targetIds: ["post-1", "post-2"],
      contractAccepted: true,
      raw: rawTips,
    });
    expect(driftedTips).toMatchObject({
      items: [],
      targetIds: ["post-1"],
      contractAccepted: false,
      raw: { tips: rawTips },
    });
  });
});
