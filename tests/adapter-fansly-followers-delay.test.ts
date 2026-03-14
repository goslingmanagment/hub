import { afterEach, describe, expect, it } from "vitest";

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
  it("keeps follower pacing above the host-global delay", async () => {
    const {
      FanslyAdapter,
      fetchMock,
    } = await loadAdapters();
    const { events, requestObserver } = captureEvents();

    fetchMock.mockImplementation(async () => fanslyFollowersResponse());

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 0,
    });
    const context = {
      session: {
        authorization: "token",
      },
      requestObserver,
    };

    await adapter.getFollowersPage(context, "acct-1", {
      offset: 0,
      limit: 100,
      minDelayMs: 5_000,
    });
    await adapter.getFollowersPage(context, "acct-1", {
      offset: 100,
      limit: 100,
      minDelayMs: 50,
    });

    const startedEvents = events.filter((event) => event.state === "started");
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents[0]?.rateLimitWaitMs).toBeNull();
    expect(Number(startedEvents[1]?.rateLimitWaitMs)).toBeGreaterThanOrEqual(45);
    expect(
      new Date(String(startedEvents[1]?.timestamp)).getTime() -
      new Date(String(startedEvents[0]?.timestamp)).getTime(),
    ).toBeGreaterThanOrEqual(45);
  });
});
