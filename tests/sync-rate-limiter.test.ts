import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

const timerMocks = vi.hoisted(() => ({
  delay: vi.fn(async () => undefined),
}));

const dbMocks = vi.hoisted(() => ({
  ensureSyncProviderRateLimitProfile: vi.fn(async () => undefined),
  reserveSyncProviderRateLimit: vi.fn(),
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: timerMocks.delay,
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    ensureSyncProviderRateLimitProfile: dbMocks.ensureSyncProviderRateLimitProfile,
    reserveSyncProviderRateLimit: dbMocks.reserveSyncProviderRateLimit,
  };
});

import { createSyncRateLimitWaiter } from "../apps/runtime/src/services/sync/rate-limiter.ts";

describe("sync rate limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T12:00:00.000Z"));
    timerMocks.delay.mockClear();
    dbMocks.ensureSyncProviderRateLimitProfile.mockClear();
    dbMocks.reserveSyncProviderRateLimit.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the reserved DB wait time for repeated dm_messages requests on the same egress", async () => {
    dbMocks.reserveSyncProviderRateLimit
      .mockResolvedValueOnce(new Date("2026-03-20T12:00:00.000Z"))
      .mockResolvedValueOnce(new Date("2026-03-20T12:00:05.000Z"));

    const db = {} as never;
    const app = {
      config: {
        syncSharedRateLimitEnabled: true,
        fanslyDefaultDelayMs: 2_500,
        fanslyDmConversationsDelayMs: 5_000,
        fanslyDmMessagesDelayMs: 5_000,
        followerPageDelayMs: 5_000,
        onlyFansDefaultDelayMs: 1_000,
      } as never,
      db,
    };

    const waiter = createSyncRateLimitWaiter(app, {
      egressKey: "socks5://proxy.example:1080",
    });

    expect(waiter).not.toBeNull();

    const scopes = [
      { provider: "fansly" as const, scope: "global" },
      { provider: "fansly" as const, scope: "dm_messages" },
    ];

    const firstWaitMs = await waiter!(scopes);
    const secondWaitMs = await waiter!(scopes);

    expect(firstWaitMs).toBe(0);
    expect(secondWaitMs).toBe(5_000);
    expect(timerMocks.delay).toHaveBeenCalledTimes(1);
    expect(timerMocks.delay).toHaveBeenCalledWith(5_000);
    expect(dbMocks.ensureSyncProviderRateLimitProfile).toHaveBeenCalledTimes(1);
    expect(dbMocks.ensureSyncProviderRateLimitProfile).toHaveBeenCalledWith(db, {
      provider: "fansly",
      egressKey: "socks5://proxy.example:1080",
      scopes: [
        { scope: "global", minSpacingMs: 2_600 },
        { scope: "followers_page", minSpacingMs: 5_000 },
        { scope: "dm_conversations", minSpacingMs: 5_000 },
        { scope: "dm_messages", minSpacingMs: 5_000 },
      ],
    });
    expect(dbMocks.reserveSyncProviderRateLimit).toHaveBeenNthCalledWith(1, db, {
      scopes: [
        { provider: "fansly", scope: "global", egressKey: "socks5://proxy.example:1080" },
        { provider: "fansly", scope: "dm_messages", egressKey: "socks5://proxy.example:1080" },
      ],
    });
    expect(dbMocks.reserveSyncProviderRateLimit).toHaveBeenNthCalledWith(2, db, {
      scopes: [
        { provider: "fansly", scope: "global", egressKey: "socks5://proxy.example:1080" },
        { provider: "fansly", scope: "dm_messages", egressKey: "socks5://proxy.example:1080" },
      ],
    });
  });
});
