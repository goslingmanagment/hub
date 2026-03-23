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

  it("renders stalled streams with a no-activity label instead of running duration", () => {
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

    expect(html).toContain("Stalled");
    expect(html).toContain("No activity");
    expect(html).not.toContain("Running 20m");
  });
});
