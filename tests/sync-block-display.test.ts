import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatBlockSummary,
  formatSubstreamStateLabel,
  getBlockStateLabel,
  getBlockTone,
  getDependencyWaitDetail,
  getSubstreamTone,
  needsVisualAttention,
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

  it("describes supporting financial enrichment separately from current transactions", () => {
    expect(formatBlockSummary({
      block: "financials",
      state: "backfilling",
      lastSuccessAt: "2026-03-24T11:59:00.000Z",
      progress: {
        label: "14 / 15 months",
        current: 14,
        total: 15,
        unit: "months",
        percent: 93.33,
        details: {},
      },
      progressStream: "top_spenders",
      progressRole: "supporting",
      error: null,
      statusReason: null,
      primaryFresh: true,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { transactionCount: 120 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe("Transactions are current; top spenders enrichment is catching up");
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

  it("replaces 100% messages live progress with finalizing copy", () => {
    const block = {
      block: "messages_live",
      state: "syncing",
      lastSuccessAt: "2026-03-24T11:50:00.000Z",
      progress: {
        label: "27 / 27 conversations",
        current: 27,
        total: 27,
        unit: "conversations",
        percent: 100,
        details: {},
      },
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { visibleConversationCount: 27 },
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(formatBlockSummary(block)).toBe("Finalizing conversation refresh…");
    expect(shouldShowBlockProgressBar(block)).toBe(false);
  });

  it("shows numeric progress for messages live when current is below total", () => {
    const block = {
      block: "messages_live",
      state: "syncing",
      lastSuccessAt: "2026-03-24T11:50:00.000Z",
      progress: {
        label: "200 / 5,000 conversations",
        current: 200,
        total: 5000,
        unit: "conversations",
        percent: 4,
        details: {},
      },
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { visibleConversationCount: 5000 },
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(formatBlockSummary(block)).toBe("Syncing… 200/5,000 conversations");
    expect(shouldShowBlockProgressBar(block)).toBe(true);
  });

  it("formats dependency waits without showing raw stream ids", () => {
    const block = {
      block: "financials",
      state: "delayed",
      lastSuccessAt: null,
      progress: null,
      error: {
        stream: "top_spenders",
        code: "unmet_dependency",
        summary: "Waiting for transactions",
        lastFailedAt: null,
        consecutiveFailures: 0,
      },
      statusReason: {
        code: "unmet_dependency",
        summary: "Waiting for transactions",
        waitingFor: ["transactions"],
      },
      primaryFresh: false,
      progressStream: null,
      progressRole: null,
      needsAttention: true,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: {},
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(formatBlockSummary(block)).toBe("Waiting for transactions to finish first");
    expect(getDependencyWaitDetail(block)).toBe("transactions");
  });

  it("collapses long dependency waits into a generic summary", () => {
    const block = {
      block: "messages_live",
      state: "delayed",
      lastSuccessAt: null,
      progress: null,
      error: {
        stream: "dm_conversations",
        code: "unmet_dependency",
        summary: "Waiting for light, top_spenders, transactions, subscribers, followers",
        lastFailedAt: null,
        consecutiveFailures: 0,
      },
      statusReason: {
        code: "unmet_dependency",
        summary: "Waiting for light, top_spenders, transactions, subscribers, followers",
        waitingFor: ["light", "top_spenders", "transactions", "subscribers", "followers"],
      },
      primaryFresh: false,
      progressStream: null,
      progressRole: null,
      needsAttention: true,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: {},
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(formatBlockSummary(block)).toBe("Waiting for prerequisite syncs to finish first");
    expect(getDependencyWaitDetail(block)).toBe(
      "connection, top spenders, transactions, subscribers, followers",
    );
    expect(needsVisualAttention(block)).toBe(false);
  });

  it("renders inline human-readable reasons for delayed substreams", () => {
    expect(formatSubstreamStateLabel({
      stream: "transactions",
      role: "primary",
      state: "delayed",
      lastSuccessAt: "2026-03-24T11:55:00.000Z",
      nextDueAt: "2026-03-24T12:55:00.000Z",
      nextRetryAt: null,
      cadenceSeconds: 3600,
      isFresh: true,
      needsAttention: true,
      statusReason: {
        code: "queue_delayed",
        summary: "Queued too long with no active sync making progress.",
        waitingFor: null,
      },
      error: null,
    } as never)).toBe("Delayed · queue stalled");

    expect(formatSubstreamStateLabel({
      stream: "followers_reconcile",
      role: "supporting",
      state: "delayed",
      lastSuccessAt: null,
      nextDueAt: "2026-03-24T12:21:00.000Z",
      nextRetryAt: null,
      cadenceSeconds: 172800,
      isFresh: false,
      needsAttention: true,
      statusReason: {
        code: "unmet_dependency",
        summary: "Waiting for followers",
        waitingFor: ["followers"],
      },
      error: null,
    } as never)).toBe("Waiting · followers");
  });

  it("describes expected queue waits without warning copy", () => {
    const block = {
      block: "financials",
      state: "scheduled",
      lastSuccessAt: "2026-03-24T11:55:00.000Z",
      progress: {
        label: "15 / 15 months",
        current: 15,
        total: 15,
        unit: "months",
        percent: 100,
        details: {},
      },
      progressStream: "top_spenders",
      progressRole: "supporting",
      error: null,
      statusReason: {
        code: "queue_waiting",
        summary: "Queued - will start after current sync completes.",
        waitingFor: ["dm_messages"],
      },
      primaryFresh: true,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: {},
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(formatBlockSummary(block)).toBe("Up to date · waiting for message history to finish");
    expect(getBlockStateLabel(block)).toBe("Up to date");
    expect(getBlockTone(block).text).toBe("text-green");
    expect(shouldShowBlockProgressBar(block)).toBe(false);

    const substream = {
      stream: "transactions",
      role: "primary",
      state: "scheduled",
      lastSuccessAt: "2026-03-24T11:55:00.000Z",
      nextDueAt: "2026-03-24T12:55:00.000Z",
      nextRetryAt: null,
      cadenceSeconds: 3600,
      isFresh: true,
      needsAttention: false,
      statusReason: {
        code: "queue_waiting",
        summary: "Queued - will start after current sync completes.",
        waitingFor: ["dm_messages"],
      },
      error: null,
    } as never;

    expect(formatSubstreamStateLabel(substream)).toBe("Up to date · waiting for message history");
    expect(getSubstreamTone(substream).text).toBe("text-green");
  });

  it("keeps non-fresh queue waits neutral and visible", () => {
    const block = {
      block: "audience",
      state: "scheduled",
      lastSuccessAt: null,
      progress: {
        label: "14 / 15 months",
        current: 14,
        total: 15,
        unit: "months",
        percent: 93.33,
        details: {},
      },
      progressStream: "followers_reconcile",
      progressRole: "supporting",
      error: null,
      statusReason: {
        code: "queue_waiting",
        summary: "Queued - will start after current sync completes.",
        waitingFor: ["dm_messages"],
      },
      primaryFresh: false,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: {},
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(formatBlockSummary(block)).toBe("Queued — message history is running");
    expect(getBlockStateLabel(block)).toBe("Queued");
    expect(getBlockTone(block).text).toBe("text-text-secondary");
    expect(shouldShowBlockProgressBar(block)).toBe(true);
  });
});
