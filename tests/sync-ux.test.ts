import { describe, expect, it } from "vitest";

import {
  buildConversationHistorySyncUx,
  buildOverallSyncUx,
  buildPageSyncUx,
  buildStreamSyncUx,
  BULK_ENRICHMENT_SYNC_STREAMS,
  isBulkEnrichmentSyncStream,
  type SyncUxStreamLike,
} from "../apps/runtime/src/services/sync-ux.ts";

describe("sync UX summaries", () => {
  it("treats pending partial work as catching up instead of attention", () => {
    const summary = buildStreamSyncUx({
      stream: "dm_messages",
      status: "idle",
      stalled: false,
      pending: true,
      retryAt: null,
      progress: {
        label: "128 messages saved",
      },
      recentErrors: {
        total429s: 0,
        total5xxs: 0,
        failedRuns: 0,
        failedAttempts: 0,
        retryAttempts: 0,
      },
      rateHealth: {
        state: "healthy",
        nextAvailableAt: null,
      },
      activeRun: null,
      lastCompletion: {
        status: "partial",
        finishedAt: "2026-03-24T11:30:00.000Z",
      },
      succeededAt: "2026-03-24T10:00:00.000Z",
      failedAt: null,
      lastErrorSummary: null,
      consecutiveFailures: 0,
    });

    expect(summary.state).toBe("catching_up");
    expect(summary.headline).toBe("Queued to continue");
    expect(summary.requiresAction).toBe(false);
  });

  it("escalates auth failures to a reconnect action", () => {
    const summary = buildStreamSyncUx({
      stream: "followers",
      status: "blocked",
      stalled: false,
      pending: true,
      retryAt: null,
      progress: null,
      recentErrors: {
        total429s: 0,
        total5xxs: 0,
        failedRuns: 1,
        failedAttempts: 1,
        retryAttempts: 0,
      },
      rateHealth: {
        state: "healthy",
        nextAvailableAt: null,
      },
      activeRun: null,
      lastCompletion: {
        status: "failed",
        finishedAt: "2026-03-24T11:30:00.000Z",
      },
      succeededAt: null,
      failedAt: "2026-03-24T11:30:00.000Z",
      blockerKind: "auth",
      lastErrorSummary: "401 unauthorized",
      consecutiveFailures: 1,
    });

    expect(summary.state).toBe("attention");
    expect(summary.headline).toBe("Reconnect to resume sync");
    expect(summary.requiresAction).toBe(true);
  });

  it("keeps conversation previews in catching-up state while message backfill is pending", () => {
    const summary = buildConversationHistorySyncUx({
      conversationSyncUx: {
        state: "healthy",
        label: "Up to date",
        headline: "Up to date",
        detail: "Conversation sync is current.",
        progressLabel: null,
        nextRetryAt: null,
        updatedAt: "2026-03-24T11:00:00.000Z",
        requiresAction: false,
      },
      messageSyncUx: {
        state: "healthy",
        label: "Up to date",
        headline: "Up to date",
        detail: "Message sync is current.",
        progressLabel: null,
        nextRetryAt: null,
        updatedAt: "2026-03-24T11:00:00.000Z",
        requiresAction: false,
      },
      pendingMessageBackfillCount: 12,
      previewReadyConversationCount: 4,
    });

    expect(summary.state).toBe("catching_up");
    expect(summary.headline).toBe("Conversation history is still syncing");
    expect(summary.detail).toContain("12 conversations");
  });

  it("marks page summaries as off when any relevant sync is off", () => {
    const summary = buildPageSyncUx([
      {
        state: "healthy",
        label: "Up to date",
        headline: "Up to date",
        detail: "This sync is current.",
        progressLabel: null,
        nextRetryAt: null,
        updatedAt: "2026-03-24T11:00:00.000Z",
        requiresAction: false,
      },
      {
        state: "off",
        label: "Paused",
        headline: "Sync is paused",
        detail: "This sync is paused.",
        progressLabel: null,
        nextRetryAt: null,
        updatedAt: "2026-03-24T10:55:00.000Z",
        requiresAction: false,
      },
    ]);

    expect(summary.state).toBe("off");
    expect(summary.headline).toBe("Some data updates are paused");
  });

  it("marks overall summaries as off when any page sync is off", () => {
    const summary = buildOverallSyncUx([
      {
        state: "healthy",
        label: "Up to date",
        headline: "Up to date",
        detail: "All page syncs are current.",
        progressLabel: null,
        nextRetryAt: null,
        updatedAt: "2026-03-24T11:00:00.000Z",
        requiresAction: false,
      },
      {
        state: "off",
        label: "Off",
        headline: "Sync is off",
        detail: "All background syncs are off for this page.",
        progressLabel: null,
        nextRetryAt: null,
        updatedAt: "2026-03-24T10:55:00.000Z",
        requiresAction: false,
      },
    ]);

    expect(summary.state).toBe("off");
    expect(summary.headline).toBe("Some syncs are off");
  });

  it("marks conversation history as off when a DM stream is off", () => {
    const summary = buildConversationHistorySyncUx({
      conversationSyncUx: {
        state: "off",
        label: "Paused",
        headline: "Sync is paused",
        detail: "This sync is paused.",
        progressLabel: null,
        nextRetryAt: null,
        updatedAt: "2026-03-24T11:00:00.000Z",
        requiresAction: false,
      },
      messageSyncUx: {
        state: "healthy",
        label: "Up to date",
        headline: "Up to date",
        detail: "Message sync is current.",
        progressLabel: null,
        nextRetryAt: null,
        updatedAt: "2026-03-24T11:00:00.000Z",
        requiresAction: false,
      },
      pendingMessageBackfillCount: 0,
      previewReadyConversationCount: 1,
    });

    expect(summary.state).toBe("off");
    expect(summary.headline).toBe("Conversation history is off");
  });

  it("keeps repeated non-429 failures in attention even when the provider is rate limited", () => {
    const summary = buildStreamSyncUx({
      stream: "followers",
      status: "retrying",
      stalled: false,
      pending: false,
      retryAt: "2026-03-24T12:05:00.000Z",
      progress: null,
      recentErrors: {
        total429s: 1,
        total5xxs: 2,
        failedRuns: 3,
        failedAttempts: 3,
        retryAttempts: 3,
      },
      rateHealth: {
        state: "limited",
        nextAvailableAt: "2026-03-24T12:05:00.000Z",
      },
      activeRun: null,
      lastCompletion: {
        status: "failed",
        finishedAt: "2026-03-24T11:59:00.000Z",
      },
      succeededAt: "2026-03-24T10:00:00.000Z",
      failedAt: "2026-03-24T11:59:00.000Z",
      lastErrorCode: "http_500",
      lastErrorSummary: "Followers sync failed",
      consecutiveFailures: 3,
    });

    expect(summary.state).toBe("attention");
    expect(summary.headline).toBe("Sync needs attention");
  });

  it("keeps true 429 retry paths in retrying state", () => {
    const summary = buildStreamSyncUx({
      stream: "transactions",
      status: "retrying",
      stalled: false,
      pending: false,
      retryAt: "2026-03-24T12:05:00.000Z",
      progress: null,
      recentErrors: {
        total429s: 3,
        total5xxs: 0,
        failedRuns: 3,
        failedAttempts: 3,
        retryAttempts: 3,
      },
      rateHealth: {
        state: "limited",
        nextAvailableAt: "2026-03-24T12:05:00.000Z",
      },
      activeRun: null,
      lastCompletion: {
        status: "failed",
        finishedAt: "2026-03-24T11:59:00.000Z",
      },
      succeededAt: "2026-03-24T10:00:00.000Z",
      failedAt: "2026-03-24T11:59:00.000Z",
      lastErrorCode: "http_429",
      lastErrorSummary: "Rate limited",
      consecutiveFailures: 3,
    });

    expect(summary.state).toBe("retrying");
    expect(summary.detail).toContain("Rate limits slowed this sync");
  });

  function skippedStream(
    overrides: Partial<SyncUxStreamLike> = {},
  ): SyncUxStreamLike {
    return {
      stream: "fan_earnings",
      status: "idle",
      stalled: false,
      pending: false,
      retryAt: null,
      progress: null,
      recentErrors: {
        total429s: 0,
        total5xxs: 0,
        failedRuns: 0,
        failedAttempts: 0,
        retryAttempts: 0,
      },
      rateHealth: {
        state: "healthy",
        nextAvailableAt: null,
      },
      activeRun: null,
      lastCompletion: {
        status: "skipped",
        finishedAt: "2026-07-30T11:30:00.000Z",
      },
      succeededAt: "2026-07-17T14:25:00.000Z",
      failedAt: null,
      lastErrorSummary: null,
      consecutiveFailures: 0,
      ...overrides,
    };
  }

  it("does not print Up to date over a stream whose last run was a gate skip", () => {
    // Exactly the lora-1 shape: the allowlist dropped the page on 2026-07-17,
    // every later run was a gated skip, and the monitor still said "Up to date"
    // for 13 days because nothing looked past the non-null succeededAt.
    const summary = buildStreamSyncUx(skippedStream({
      lastCompletionGatedSkipReason: "not_allowlisted",
    }));

    expect(summary.state).toBe("off");
    expect(summary.headline).not.toBe("Up to date");
    expect(summary.headline).toBe("Not updating");
    expect(summary.detail).toContain("gated off");
  });

  it("does not call a lost lease gated off just because the run says skipped", () => {
    // `skipped` is ALSO what recordSkipped writes whenever a worker loses its
    // lease, which happens to perfectly healthy streams — and that row can carry
    // a LATER finished_at than the replacement run that succeeded, so
    // completed_runs picks it. Keying the state on the outcome alone reported a
    // working stream as gated off, with a detail naming a gate that does not
    // exist, until its next run landed. No recorded gate reason => not gated.
    const summary = buildStreamSyncUx(skippedStream({
      stream: "dm_messages",
      lastErrorSummary: "Page sync lease lost",
    }));

    expect(summary.state).not.toBe("off");
    expect(summary.headline).not.toBe("Not updating");
    expect(summary.detail ?? "").not.toContain("gated off");
    expect(summary.state).toBe("healthy");
  });

  it("keeps a gated bulk stream from dominating the page and fleet rollup", () => {
    // fan_earnings/purchase_history sit in MONITORED_SYNC_STREAMS and `off`
    // outranks every state below `attention`, so an honest per-stream `off`
    // would otherwise turn every Fansly page — and the fleet line above it —
    // into "Off" on a default configuration, where both ramp flags are false.
    // Decision #166 already forbids that; the monitor rollup lacked the filter.
    const pageStreams = [
      {
        stream: "light",
        syncUx: buildStreamSyncUx(skippedStream({
          stream: "light",
          lastCompletion: { status: "success", finishedAt: "2026-07-30T11:30:00.000Z" },
          succeededAt: "2026-07-30T11:30:00.000Z",
        })),
      },
      {
        stream: "fan_earnings",
        syncUx: buildStreamSyncUx(skippedStream({
          lastCompletionGatedSkipReason: "not_allowlisted",
        })),
      },
    ];
    expect(pageStreams[0]?.syncUx.state).toBe("healthy");
    expect(pageStreams[1]?.syncUx.state).toBe("off");

    // Unfiltered, one gated bulk stream decides the whole page — this pins the
    // consequence callers must avoid.
    expect(buildPageSyncUx(pageStreams.map((item) => item.syncUx)).state).toBe("off");

    // The rule the monitor now applies, spelled out with the shared predicate.
    const rollupInput = pageStreams
      .filter((item) => !isBulkEnrichmentSyncStream(item.stream))
      .map((item) => item.syncUx);
    expect(buildPageSyncUx(rollupInput).state).toBe("healthy");
    expect(buildOverallSyncUx([buildPageSyncUx(rollupInput)]).state).toBe("healthy");
  });

  it("names the bulk enrichment streams that must not dominate a rollup", () => {
    expect([...BULK_ENRICHMENT_SYNC_STREAMS]).toEqual([
      "fan_earnings",
      "purchase_history",
      // WP-F1: same class, same reason — its flag defaults false, so letting it
      // vote would make every Fansly page read "Off" from the deploy onward.
      "stats_snapshot",
      "notifications",
      "catalog",
      "post_replies",
      "payouts",
    ]);
    expect(isBulkEnrichmentSyncStream("fan_earnings")).toBe(true);
    expect(isBulkEnrichmentSyncStream("purchase_history")).toBe(true);
    expect(isBulkEnrichmentSyncStream("stats_snapshot")).toBe(true);
    expect(isBulkEnrichmentSyncStream("dm_messages")).toBe(false);
    expect(isBulkEnrichmentSyncStream("light")).toBe(false);
  });
});
