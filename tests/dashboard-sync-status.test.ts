import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const queryMocks = vi.hoisted(() => ({
  useAdminSyncRunDetail: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { SyncStatusPage } from "../apps/dashboard/src/pages/dev/SyncStatusPage.tsx";

function renderPage(initialEntry = "/dev/sync-status?runId=42") {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: [initialEntry] },
    createElement(SyncStatusPage),
  ));
}

describe("SyncStatusPage", () => {
  beforeEach(() => {
    queryMocks.useAdminSyncRunDetail.mockReset();
    queryMocks.useAdminSyncRunDetail.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });
  });

  it("shows an explicit invalid-run state when the query string is missing", () => {
    const html = renderPage("/dev/sync-status");

    expect(html).toContain("Sync run not selected");
    expect(queryMocks.useAdminSyncRunDetail).toHaveBeenCalledWith(0);
  });

  it("renders the selected sync run summary, events, and attempts", () => {
    queryMocks.useAdminSyncRunDetail.mockReturnValue({
      data: {
        run: {
          runId: 42,
          platformAccountId: 7,
          pageLabel: "lana",
          platform: "fansly",
          stream: "messages",
          trigger: "manual",
          status: "completed",
          startedAt: "2026-03-24T12:00:00.000Z",
          finishedAt: "2026-03-24T12:01:00.000Z",
          errorSummary: null,
          stats: {},
        },
        events: [{
          id: 1,
          runId: 42,
          platformAccountId: 7,
          pageLabel: "lana",
          provider: "fansly",
          stream: "messages",
          eventType: "run.started",
          severity: "info",
          message: "Started sync run",
          details: {},
          emittedAt: "2026-03-24T12:00:00.000Z",
        }],
        attempts: [{
          attemptId: 11,
          runId: 42,
          platformAccountId: 7,
          pageLabel: "lana",
          provider: "fansly",
          stream: "messages",
          operation: "fetch_messages",
          logicalRequestId: "messages:42:1",
          attemptNumber: 1,
          state: "succeeded",
          failureKind: null,
          httpStatus: 200,
          retryDelayMs: null,
          durationMs: 1800,
          requestShape: {},
          responseShape: {},
          errorMessage: null,
          startedAt: "2026-03-24T12:00:01.000Z",
          finishedAt: "2026-03-24T12:00:02.800Z",
        }],
      },
      isLoading: false,
      isError: false,
    });

    const html = renderPage();

    expect(html).toContain("Sync Run #42");
    expect(html).toContain(">lana<");
    expect(html).toContain(">fansly<");
    expect(html).toContain(">Completed<");
    expect(html).toContain("Started sync run");
    expect(html).toContain(">messages<");
    expect(html).toContain(">succeeded<");
    expect(html).toContain("1800ms");
  });
});
