import { describe, expect, it } from "vitest";

import { buildCrmMessageSyncUx, buildStreamSyncUx } from "../apps/runtime/src/services/sync-ux.ts";

describe("sync UX summaries", () => {
  it("treats pending partial work as catching up instead of attention", () => {
    const summary = buildStreamSyncUx({
      stream: "dm_messages",
      status: "idle",
      stalled: false,
      pending: true,
      backoffUntil: null,
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
      lastSuccessAt: "2026-03-24T10:00:00.000Z",
      lastFailureAt: null,
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
      status: "auth_failed",
      stalled: false,
      pending: true,
      backoffUntil: null,
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
      lastSuccessAt: null,
      lastFailureAt: "2026-03-24T11:30:00.000Z",
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
});
