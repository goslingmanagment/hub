import { describe, expect, it } from "vitest";

import {
  buildCrmMessageSyncUx,
  buildOverallSyncUx,
  buildPageSyncUx,
  buildStreamSyncUx,
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

  it("keeps CRM previews in catching-up state while message backfill is pending", () => {
    const summary = buildCrmMessageSyncUx({
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
    expect(summary.headline).toBe("Some syncs are off");
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

  it("marks CRM summaries as off when a DM stream is off", () => {
    const summary = buildCrmMessageSyncUx({
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
});
