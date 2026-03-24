import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  useAdminSyncRuns: vi.fn(),
  useSyncMonitor: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { useSyncTabData } from "../apps/dashboard/src/pages/settings/useSyncTabData.ts";

function buildSyncUx(
  overrides: Partial<{
    state: "healthy" | "syncing" | "catching_up" | "retrying" | "attention" | "setup" | "off";
    label: string;
    headline: string;
    detail: string | null;
    progressLabel: string | null;
    nextRetryAt: string | null;
    updatedAt: string | null;
    requiresAction: boolean;
  }> = {},
) {
  return {
    state: "healthy" as const,
    label: "Up to date",
    headline: "Up to date",
    detail: "All syncs are current.",
    progressLabel: null,
    nextRetryAt: null,
    updatedAt: "2026-03-24T11:55:00.000Z",
    requiresAction: false,
    ...overrides,
  };
}

function buildMonitorStream(
  overrides: Partial<{
    stream: "light" | "transactions" | "subscribers" | "followers" | "followers_reconcile" | "dm_conversations" | "dm_messages";
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastErrorSummary: string | null;
    consecutiveFailures: number;
    activeRun: { runId: number; trigger: string; startedAt: string; lastActivityAt: string } | null;
    progress: { label: string; current: number; total: number | null; unit: string; percent: number | null } | null;
    recentErrors: {
      total429s: number;
      total5xxs: number;
      failedRuns: number;
      failedAttempts: number;
      retryAttempts: number;
      last429At: string | null;
      last5xxAt: string | null;
    };
    syncUx: ReturnType<typeof buildSyncUx>;
  }> = {},
) {
  return {
    stream: "transactions" as const,
    status: "completed" as const,
    stalled: false,
    pending: false,
    backoffUntil: null,
    progress: null,
    recentRuns: { running: 0, success: 1, partial: 0, failed: 0, skipped: 0 },
    recentErrors: {
      total429s: 0,
      total5xxs: 0,
      failedRuns: 0,
      failedAttempts: 0,
      retryAttempts: 0,
      last429At: null,
      last5xxAt: null,
    },
    rateHealth: { state: "healthy" as const, last429At: null, nextAvailableAt: null },
    activeRun: null,
    lastCompletion: null,
    lastSuccessAt: "2026-03-24T12:00:00.000Z",
    lastFailureAt: null,
    lastErrorSummary: null,
    consecutiveFailures: 0,
    syncUx: buildSyncUx(),
    ...overrides,
  };
}

function SyncTabDataProbe() {
  const data = useSyncTabData();
  return createElement("pre", {
    dangerouslySetInnerHTML: { __html: JSON.stringify(data) },
  });
}

describe("sync tab data", () => {
  beforeEach(() => {
    queryMocks.useAdminSyncRuns.mockReset();
    queryMocks.useSyncMonitor.mockReset();
  });

  it("keeps non-auth errors alongside credentials issues and parses checkpoint counts safely", () => {
    queryMocks.useSyncMonitor.mockReturnValue({
      isLoading: false,
      data: {
        generatedAt: "2026-03-24T12:00:00.000Z",
        window: { hours: 24, startedAt: "2026-03-23T12:00:00.000Z" },
        overall: {
          pages: 1,
          streams: 7,
          runningStreams: 1,
          failedStreams: 2,
          stalledStreams: 0,
          pendingStreams: 0,
          backoffStreams: 0,
          counts: {
            fans: 0,
            followers: 42,
            subscribers: 12,
            transactions: 100,
            conversations: 4,
            messages: 20,
          },
          recentRuns: { running: 0, success: 1, partial: 0, failed: 0, skipped: 0 },
          recentErrors: {
            total429s: 0,
            total5xxs: 0,
            failedRuns: 0,
            failedAttempts: 0,
            retryAttempts: 0,
            last429At: null,
            last5xxAt: null,
          },
          providers: [],
          syncUx: buildSyncUx(),
        },
        pages: [{
          pageId: 1,
          pageLabel: "lana",
          platform: "fansly" as const,
          modelSlug: "lana",
          modelName: "Lana",
          username: "lana",
          displayName: "Lana",
          counts: {
            fans: 0,
            followers: 42,
            subscribers: 12,
            transactions: 100,
            conversations: 4,
            messages: 20,
          },
          summary: {
            runningStreams: 1,
            failedStreams: 2,
            stalledStreams: 0,
            pendingStreams: 0,
            backoffStreams: 0,
          },
          streams: [
            buildMonitorStream({ stream: "transactions" }),
            buildMonitorStream({
              stream: "followers",
              lastSuccessAt: null,
              lastFailureAt: "2026-03-24T11:30:00.000Z",
              lastErrorSummary: "provider temporary failure",
              consecutiveFailures: 2,
              recentErrors: {
                total429s: 0,
                total5xxs: 1,
                failedRuns: 1,
                failedAttempts: 1,
                retryAttempts: 0,
                last429At: null,
                last5xxAt: "2026-03-24T11:30:00.000Z",
              },
              progress: {
                label: "4/10 followers",
                current: 4,
                total: 10,
                unit: "followers",
                percent: 40,
              },
            }),
            buildMonitorStream({
              stream: "followers_reconcile",
              activeRun: {
                runId: 77,
                trigger: "manual",
                startedAt: "2026-03-24T11:58:00.000Z",
                lastActivityAt: "2026-03-24T11:59:30.000Z",
              },
              progress: {
                label: "2/10 followers",
                current: 2,
                total: 10,
                unit: "followers",
                percent: 20,
              },
            }),
            buildMonitorStream({
              stream: "subscribers",
              lastSuccessAt: "2026-03-24T10:00:00.000Z",
            }),
            buildMonitorStream({
              stream: "dm_conversations",
              lastSuccessAt: null,
              lastFailureAt: "2026-03-24T11:45:00.000Z",
              lastErrorSummary: "Session expired",
              consecutiveFailures: 1,
              syncUx: buildSyncUx({
                state: "attention",
                label: "Reconnect",
                headline: "Reconnect to resume sync",
                requiresAction: true,
              }),
            }),
            buildMonitorStream({
              stream: "dm_messages",
              lastSuccessAt: "2026-03-24T11:00:00.000Z",
            }),
          ],
          syncUx: buildSyncUx({
            state: "attention",
            label: "Reconnect",
            headline: "Reconnect to resume sync",
            requiresAction: true,
          }),
        }],
        recentEvents: [],
      },
    });
    queryMocks.useAdminSyncRuns.mockReturnValue({
      data: [{
        runId: 1,
        platformAccountId: 1,
        pageLabel: "lana",
        platform: "fansly" as const,
        stream: "subscribers",
        trigger: "manual",
        status: "success",
        startedAt: "2026-03-24T11:40:00.000Z",
        finishedAt: "2026-03-24T11:41:00.000Z",
        errorSummary: null,
        stats: {
          checkpoint: {
            after: {
              subscribers: {
                state: {
                  offset: 12,
                },
              },
            },
          },
        },
      }],
    });

    const html = renderToStaticMarkup(createElement(SyncTabDataProbe));
    const match = html.match(/<pre>(.*)<\/pre>/);
    const parsed = JSON.parse(match?.[1] ?? "{}");
    const page = parsed.pages[0];

    expect(page.isSyncingData).toBe(true);
    expect(page.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "Credentials", message: "Credentials may have expired" }),
      expect.objectContaining({
        category: "Followers",
        message: "Failed to fetch followers \u2014 Fansly returned server errors",
      }),
    ]));
    expect(page.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: "Subscribers synced \u00b7 12 subscribers" }),
    ]));
    expect(page.freshness).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Followers", isActive: true }),
    ]));
  });
});
