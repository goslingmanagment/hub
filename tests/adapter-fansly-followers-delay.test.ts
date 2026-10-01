import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureEvents,
  cleanupAdapterHarness,
  fanslyFollowersResponse,
  loadAdapters,
} from "./helpers/adapter-harness.ts";
import { createTestFanslySendGuard } from "./helpers/fansly-send-guard.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("adapter hardening", () => {
  it("keeps follower pacing above the host-global delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));

    const {
      FanslyAdapter,
      fetchMock,
    } = await loadAdapters();
    const { events, requestObserver } = captureEvents();

    fetchMock.mockImplementation(async () => fanslyFollowersResponse());

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
    });
    const context = {
      sendGuard: createTestFanslySendGuard(),
      session: {
        authorization: "token",
      },
      proxy: { url: "socks5://proxy.example:1080" },
      requestObserver,
    };

    await adapter.getFollowersPage(context, "acct-1", {
      offset: 0,
      limit: 100,
      minDelayMs: 5_000,
    });
    const delayedRequest = adapter.getFollowersPage(context, "acct-1", {
      offset: 100,
      limit: 100,
      minDelayMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    await delayedRequest;

    const startedEvents = events.filter((event) => event.state === "started");
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents[0]?.rateLimitWaitMs).toBeNull();
    expect(startedEvents[1]?.rateLimitWaitMs).toBe(50);
    expect(
      new Date(String(startedEvents[1]?.timestamp)).getTime() -
      new Date(String(startedEvents[0]?.timestamp)).getTime(),
    ).toBe(50);
  });
});
