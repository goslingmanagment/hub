import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  usePageConversationMessages: vi.fn(),
  useSyncMonitor: vi.fn(),
  useSyncRequests: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { SyncMonitorPage } from "../apps/dashboard/src/pages/SyncMonitorPage.tsx";

function renderPage() {
  return renderToStaticMarkup(createElement(SyncMonitorPage));
}

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

describe("SyncMonitorPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    queryMocks.usePageConversationMessages.mockReset();
    queryMocks.useSyncMonitor.mockReset();
    queryMocks.useSyncRequests.mockReset();
    queryMocks.usePageConversationMessages.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
    queryMocks.useSyncRequests.mockReturnValue({
      data: [],
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the aggregate hero summary separate from stream-level diagnostics", () => {
    queryMocks.useSyncMonitor.mockReturnValue({
      data: {
        generatedAt: "2026-03-24T11:59:30.000Z",
        overall: {
          pages: 1,
          streams: 1,
          runningStreams: 1,
          failedStreams: 0,
          stalledStreams: 1,
          pendingStreams: 0,
          backoffStreams: 0,
          recentRuns: {
            running: 1,
            success: 0,
            partial: 0,
            failed: 0,
            skipped: 0,
          },
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
          syncUx: buildSyncUx({
            state: "attention",
            label: "Needs attention",
            headline: "Sync needs attention",
            detail: "One or more syncs need help before they can catch up.",
            updatedAt: "2026-03-24T11:49:00.000Z",
          }),
        },
        pages: [{
          pageId: 1,
          pageLabel: "lora-1",
          platform: "fansly",
          modelSlug: "lora",
          modelName: "Lora Vie",
          username: "LoraVie",
          displayName: "Lora Vie",
          counts: {
            fans: 0,
            followers: 0,
            subscribers: 0,
            transactions: 0,
            conversations: 0,
            messages: 0,
          },
          summary: {
            runningStreams: 1,
            failedStreams: 0,
            stalledStreams: 1,
            pendingStreams: 0,
            backoffStreams: 0,
          },
          syncUx: buildSyncUx({
            state: "attention",
            label: "Needs attention",
            headline: "Sync needs attention",
            detail: "One or more syncs need help before they can catch up.",
            updatedAt: "2026-03-24T11:49:00.000Z",
          }),
          streams: [{
            stream: "followers",
            status: "running",
            stalled: true,
            pending: false,
            backoffUntil: null,
            progress: null,
            recentRuns: {
              running: 1,
              success: 0,
              partial: 0,
              failed: 0,
              skipped: 0,
            },
            recentErrors: {
              total429s: 0,
              total5xxs: 0,
              failedRuns: 0,
              failedAttempts: 0,
              retryAttempts: 0,
              last429At: null,
              last5xxAt: null,
            },
            rateHealth: {
              state: "healthy",
              last429At: null,
              nextAvailableAt: null,
            },
            activeRun: {
              runId: 7,
              trigger: "onboarding",
              startedAt: "2026-03-24T11:40:00.000Z",
              lastActivityAt: "2026-03-24T11:49:00.000Z",
            },
            lastCompletion: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastErrorSummary: null,
            consecutiveFailures: 0,
            syncUx: buildSyncUx({
              state: "attention",
              label: "Needs attention",
              headline: "Sync needs attention",
              detail: "This sync stopped making progress and needs the worker to recover.",
              updatedAt: "2026-03-24T11:49:00.000Z",
            }),
          }],
        }],
        recentEvents: [],
        window: {
          hours: 24,
          startedAt: "2026-03-23T12:00:00.000Z",
        },
      },
      isLoading: false,
    });

    const html = renderPage();
    const overallDetailMatches = html.match(/One or more syncs need help before they can catch up\./g) ?? [];

    expect(html).toContain("Sync Diagnostics");
    expect(html).toContain("Sync needs attention");
    expect(html).toContain("needs the worker to recover");
    expect(overallDetailMatches).toHaveLength(1);
    expect(html).not.toContain("Running 20m");
  });

  it("renders paused streams in an off section instead of healthy", () => {
    queryMocks.useSyncMonitor.mockReturnValue({
      data: {
        generatedAt: "2026-03-24T11:59:30.000Z",
        overall: {
          pages: 1,
          streams: 1,
          runningStreams: 0,
          failedStreams: 0,
          stalledStreams: 0,
          pendingStreams: 0,
          backoffStreams: 0,
          recentRuns: {
            running: 0,
            success: 0,
            partial: 0,
            failed: 0,
            skipped: 0,
          },
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
          syncUx: buildSyncUx({
            state: "off",
            label: "Off",
            headline: "Some syncs are off",
            detail: "1 sync is paused or disabled on this page.",
            updatedAt: "2026-03-24T11:49:00.000Z",
          }),
        },
        pages: [{
          pageId: 1,
          pageLabel: "lora-1",
          platform: "fansly",
          modelSlug: "lora",
          modelName: "Lora Vie",
          username: "LoraVie",
          displayName: "Lora Vie",
          counts: {
            fans: 0,
            followers: 0,
            subscribers: 0,
            transactions: 0,
            conversations: 0,
            messages: 0,
          },
          summary: {
            runningStreams: 0,
            failedStreams: 0,
            stalledStreams: 0,
            pendingStreams: 0,
            backoffStreams: 0,
          },
          syncUx: buildSyncUx({
            state: "off",
            label: "Off",
            headline: "Some syncs are off",
            detail: "1 sync is paused or disabled on this page.",
            updatedAt: "2026-03-24T11:49:00.000Z",
          }),
          streams: [{
            stream: "followers",
            status: "paused",
            stalled: false,
            pending: false,
            backoffUntil: null,
            progress: null,
            recentRuns: {
              running: 0,
              success: 0,
              partial: 0,
              failed: 0,
              skipped: 0,
            },
            recentErrors: {
              total429s: 0,
              total5xxs: 0,
              failedRuns: 0,
              failedAttempts: 0,
              retryAttempts: 0,
              last429At: null,
              last5xxAt: null,
            },
            rateHealth: {
              state: "healthy",
              last429At: null,
              nextAvailableAt: null,
            },
            activeRun: null,
            lastCompletion: null,
            lastSuccessAt: "2026-03-24T11:49:00.000Z",
            lastFailureAt: null,
            lastErrorSummary: null,
            consecutiveFailures: 0,
            syncUx: buildSyncUx({
              state: "off",
              label: "Paused",
              headline: "Sync is paused",
              detail: "This sync is paused.",
              updatedAt: "2026-03-24T11:49:00.000Z",
            }),
          }],
        }],
        recentEvents: [],
        window: {
          hours: 24,
          startedAt: "2026-03-23T12:00:00.000Z",
        },
      },
      isLoading: false,
    });

    const html = renderPage();
    const pageSummaryMatches = html.match(/Some syncs are off/g) ?? [];

    expect(html).toContain("Some syncs are off");
    expect(html).toContain("Off");
    expect(html).toContain("Sync is paused");
    expect(pageSummaryMatches).toHaveLength(1);
    expect(html).not.toContain("Healthy (1)");
  });
});
