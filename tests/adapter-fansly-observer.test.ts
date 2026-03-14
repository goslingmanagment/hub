import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureEvents,
  cleanupAdapterHarness,
  fanslyFollowersResponse,
  loadAdapters,
} from "./helpers/adapter-harness.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("adapter hardening", () => {
  it("emits sanitized Fansly request observer events for offset pagination", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);

    const {
      FanslyAdapter,
      fetchMock,
    } = await loadAdapters();
    const { events, requestObserver } = captureEvents();

    fetchMock.mockResolvedValue(fanslyFollowersResponse());

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
    });

    await adapter.getFollowersPage({
      session: {
        authorization: "super-secret-token",
      },
      requestObserver,
    }, "acct-secret-123", {
      offset: 200,
      limit: 100,
      after: "raw-follow-cursor",
    });

    expect(events.map((event) => event.state)).toEqual(["started", "success"]);
    expect(events[0]).toMatchObject({
      operation: "followers",
      endpointTemplate: "/account/:accountId/followersnew",
      attemptNumber: 1,
      pagination: {
        offset: 200,
        limit: 100,
      },
      requestMetadata: {
        offset: 200,
        limit: 100,
        afterPresent: true,
        beforePresent: false,
      },
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("acct-secret-123");
    expect(serialized).not.toContain("raw-follow-cursor");
    expect(serialized).not.toContain("super-secret-token");
  });
});
