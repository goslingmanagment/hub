import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatBlockSummary,
  shouldShowBlockProgressBar,
} from "../apps/dashboard/src/pages/settings/sync/syncBlockDisplay.ts";

describe("sync block display", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the backend's block-specific metric keys in summaries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));

    expect(formatBlockSummary({
      block: "financials",
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
      block: "audience",
      state: "up_to_date",
      lastSuccessAt: "2026-03-24T11:30:00.000Z",
      progress: null,
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { followerCount: 5 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe("Updated 30m ago · 5 followers");

    expect(formatBlockSummary({
      block: "messages_live",
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

  it("renders stalled blocks with the point they got stuck at", () => {
    expect(formatBlockSummary({
      block: "audience",
      state: "failed",
      lastSuccessAt: "2026-03-18T10:00:00.000Z",
      progress: {
        label: "1 of 697 subscribers processed",
        current: 1,
        total: 697,
        unit: "subscribers",
        percent: 0.14347202295552366,
        details: {},
      },
      error: {
        stream: "subscribers",
        code: "progress_stalled",
        summary: "Sync stopped making progress",
        lastFailedAt: null,
        consecutiveFailures: 0,
      },
      needsAttention: true,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { subscriberCount: 1 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe("Sync stalled at 1/697 subscribers");
  });

  it("renders backfilling blocks without the active syncing copy", () => {
    expect(formatBlockSummary({
      block: "audience",
      state: "backfilling",
      lastSuccessAt: "2026-03-18T10:00:00.000Z",
      progress: {
        label: "1 of 697 subscribers processed",
        current: 1,
        total: 697,
        unit: "subscribers",
        percent: 0.14347202295552366,
        details: {},
      },
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { subscriberCount: 1 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe("Backfilling… 1/697 subscribers");
  });

  it("hides completed progress bars once a block is up to date", () => {
    expect(shouldShowBlockProgressBar({
      block: "financials",
      state: "up_to_date",
      lastSuccessAt: "2026-03-24T11:55:00.000Z",
      progress: {
        label: "15 / 15 months",
        current: 15,
        total: 15,
        unit: "months",
        percent: 100,
        details: {},
      },
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { transactionCount: 2879 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe(false);
  });

  it("uses non-numeric copy for audience follower refresh progress", () => {
    const block = {
      block: "audience",
      state: "syncing",
      lastSuccessAt: "2026-03-24T11:53:00.000Z",
      progress: {
        label: "75 / 75 followers",
        current: 75,
        total: 75,
        unit: "followers",
        percent: 100,
        details: {},
      },
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { followerCount: 4821 },
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(formatBlockSummary(block)).toBe("Refreshing followers…");
    expect(shouldShowBlockProgressBar(block)).toBe(false);
  });
});
