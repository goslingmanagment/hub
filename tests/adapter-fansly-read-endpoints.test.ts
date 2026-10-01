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

function context() {
  return {
    sendGuard: createTestFanslySendGuard(),
    session: { authorization: "token" },
    proxy: { url: "socks5://proxy.example:1080" },
  };
}

describe("Fansly read endpoint contracts", () => {
  it("supports earnings overview, tracking links, account lists, and list items", async () => {
    const { FanslyAdapter, fetchMock } = await loadAdapters();
    const earningsRaw = { pendingBalance: 50_000, additive: "retained" };
    const trackingRaw = [{
      id: "tracking-1",
      accountId: "creator-1",
      internalId: "slug-1",
      type: 1,
      status: 1,
      label: "Profile",
      description: "",
      metadata: "{}",
      createdAt: 1_771_671_617,
      clicks: 12,
      claims: 4,
      follows: 3,
      subscriptions: 2,
      totalNet: 4_500,
      totalGross: 5_000,
      additive: true,
    }];
    const listsRaw = [{
      id: "list-1",
      accountId: "creator-1",
      pos: null,
      type: 1,
      label: "VIP",
      itemCount: 1,
      items: [{
        id: "item-1",
        sortId: "100",
        listId: "list-1",
        type: 1,
        metadata: "{}",
      }],
    }];
    const listItemsRaw = [{
      id: "item-1",
      sortId: "100",
      listId: "list-1",
      type: 1,
      metadata: "{}",
      additive: "retained",
    }];
    const malformedEarnings = { pendingBalance: "50000" };
    const malformedTracking = [
      { id: "tracking-float", clicks: 1.5 },
      { id: "tracking-unsafe", totalGross: Number.MAX_SAFE_INTEGER + 1 },
    ];
    const malformedLists = [{ id: "list-1", items: [null] }];
    const malformedItems = [{ id: 123, listId: "list-1" }];

    fetchMock
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: earningsRaw }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: trackingRaw }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: listsRaw }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: listItemsRaw }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: [] }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: malformedEarnings }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: malformedTracking }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: malformedLists }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: malformedItems }))
      .mockResolvedValueOnce(toJsonResponse({
        success: "true",
        response: [],
        error: { message: 42 },
      }));

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
    });
    const requestContext = context();
    const earnings = await adapter.getEarningsOverview(requestContext);
    const trackingLinks = await adapter.getTrackingLinks(requestContext);
    const accountLists = await adapter.getListsAccount(requestContext, " fan-1 ");
    const listItems = await adapter.getListItemsPage(requestContext, {
      listId: " list-1 ",
      limit: 25,
      after: "cursor-1",
      sortMode: 3,
    });
    const allLists = await adapter.getListsAccount(requestContext);
    const driftedEarnings = await adapter.getEarningsOverview(requestContext);
    const driftedTracking = await adapter.getTrackingLinks(requestContext);
    const driftedLists = await adapter.getListsAccount(requestContext);
    const driftedItems = await adapter.getListItemsPage(requestContext, {
      listId: "list-1",
    });

    expect(earnings).toEqual({
      pendingBalanceMills: 50_000n,
      contractAccepted: true,
      raw: earningsRaw,
    });
    expect(typeof earnings.pendingBalanceMills).toBe("bigint");
    expect(trackingLinks).toEqual({
      items: trackingRaw,
      contractAccepted: true,
      raw: trackingRaw,
    });
    expect(accountLists).toEqual({
      items: listsRaw,
      itemId: "fan-1",
      contractAccepted: true,
      raw: listsRaw,
    });
    expect(listItems).toEqual({
      items: listItemsRaw,
      listId: "list-1",
      after: "cursor-1",
      contractAccepted: true,
      raw: listItemsRaw,
    });
    expect(allLists).toMatchObject({
      itemId: null,
      contractAccepted: true,
      items: [],
    });
    expect(driftedEarnings).toEqual({
      pendingBalanceMills: null,
      contractAccepted: false,
      raw: malformedEarnings,
    });
    expect(driftedTracking).toEqual({
      items: [],
      contractAccepted: false,
      raw: malformedTracking,
    });
    expect(driftedLists).toEqual({
      items: [],
      itemId: null,
      contractAccepted: false,
      raw: malformedLists,
    });
    expect(driftedItems).toEqual({
      items: [],
      listId: "list-1",
      after: null,
      contractAccepted: false,
      raw: malformedItems,
    });

    await expect(adapter.getTrackingLinks(requestContext)).rejects.toThrow(
      "Fansly response envelope was unsuccessful",
    );
    await expect(adapter.getListItemsPage(requestContext, { listId: "   " })).rejects.toThrow(
      "Fansly list items request requires a list id",
    );
    await expect(adapter.getListItemsPage(requestContext, {
      listId: "list-1",
      limit: 1.5,
    })).rejects.toThrow("limit must be a safe integer between 1 and 100");
    await expect(adapter.getListItemsPage(requestContext, {
      listId: "list-1",
      limit: 101,
    })).rejects.toThrow("limit must be a safe integer between 1 and 100");
    await expect(adapter.getListItemsPage(requestContext, {
      listId: "list-1",
      sortMode: -1,
    })).rejects.toThrow("sort mode must be a non-negative safe integer");
    await expect(adapter.getListItemsPage(requestContext, {
      listId: "list-1",
      after: "   ",
    })).rejects.toThrow("cursor must be nonblank when supplied");
    await adapter.close();

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.slice(0, 4).map((url) => url.pathname)).toEqual([
      "/account/wallets/earnings",
      "/trackinglinks",
      "/lists/account",
      "/lists/itemsnew",
    ]);
    expect(urls[2]?.searchParams.get("itemId")).toBe("fan-1");
    expect(urls[3]?.searchParams.get("listId")).toBe("list-1");
    expect(urls[3]?.searchParams.get("limit")).toBe("25");
    expect(urls[3]?.searchParams.get("after")).toBe("cursor-1");
    expect(urls[3]?.searchParams.get("sortMode")).toBe("3");
    expect(urls[4]?.searchParams.has("itemId")).toBe(true);
    expect(urls[4]?.searchParams.get("itemId")).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});
