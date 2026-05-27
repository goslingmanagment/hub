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

describe("OnlyFans link user adapter", () => {
  it("emits observer metadata for link user pagination without leaking cursors", async () => {
    const {
      OnlyFansAdapter,
      fetchMock,
    } = await loadAdapters();
    const { events, requestObserver } = captureEvents();

    fetchMock.mockResolvedValueOnce(toJsonResponse({
      items: [{
        link_id: "link-1",
        fan: {
          id: "fan-1",
          name: "Fan One",
          username: "fan_one",
        },
        subscribed_at: "2026-05-20T10:00:00.000Z",
        collected_at: "2026-05-20T10:01:00.000Z",
      }],
      cursor: "next-link-cursor",
    }));

    const adapter = new OnlyFansAdapter({
      baseUrl: "https://onlyfans.example",
      defaultDelayMs: 0,
    });

    await adapter.getTrackingLinkUsersPage({
      auth: {
        token: "om-super-secret-token",
      },
      requestObserver,
    }, "platform-account-secret", {
      collectedFrom: new Date("2026-05-01T00:00:00.000Z"),
      collectedTo: new Date("2026-05-28T00:00:00.000Z"),
      cursor: "cursor-secret-123",
      limit: 750,
      pageIndex: 2,
    });

    expect(events.at(-1)).toMatchObject({
      state: "success",
      operation: "onlymonster_tracking_link_users",
      endpointTemplate: "/api/v0/platforms/onlyfans/accounts/:platformAccountId/tracking-link-users",
      pagination: {
        pageIndex: 2,
        cursorPresent: true,
      },
      requestMetadata: {
        collectedFromPresent: true,
        collectedToPresent: true,
        cursorPresent: true,
        limit: 750,
      },
      responseMetadata: {
        returnedItems: 1,
        cursorPresent: true,
      },
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("platform-account-secret");
    expect(serialized).not.toContain("cursor-secret-123");
    expect(serialized).not.toContain("next-link-cursor");
    expect(serialized).not.toContain("om-super-secret-token");
    await adapter.close();
  });
});
