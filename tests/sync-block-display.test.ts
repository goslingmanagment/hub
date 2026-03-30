import { afterEach, describe, expect, it, vi } from "vitest";

import { formatBlockSummary } from "../apps/dashboard/src/pages/settings/sync/syncBlockDisplay.ts";

describe("sync block display", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the backend's block-specific metric keys in summaries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));

    expect(formatBlockSummary({
      block: "transactions",
      state: "up_to_date",
      lastSuccessAt: "2026-03-24T11:00:00.000Z",
      progress: null,
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { transactionCount: 12 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe("Updated 1h ago · 12 transactions");

    expect(formatBlockSummary({
      block: "subscribers",
      state: "up_to_date",
      lastSuccessAt: "2026-03-24T11:30:00.000Z",
      progress: null,
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { subscriberCount: 5 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe("Updated 30m ago · 5 active");

    expect(formatBlockSummary({
      block: "messages",
      state: "up_to_date",
      lastSuccessAt: "2026-03-24T10:00:00.000Z",
      progress: null,
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { visibleConversationCount: 4 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe("Updated 2h ago · 4 conversations");
  });
});
