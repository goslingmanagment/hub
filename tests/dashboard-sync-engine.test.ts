import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSyncPageStatus, SyncBlockStatus, SyncBlocksPage } from "@agency_hub_core/contracts";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

// Root tests cannot resolve @tanstack/react-query, so the api layer is mocked
// at module level (same pattern as dashboard-sync-surfaces.test.ts).
const mutation = () => ({ isPending: false, mutateAsync: vi.fn() });
const queries = vi.hoisted(() => ({
  useSyncOverview: vi.fn(),
  usePageSyncBlocks: vi.fn(),
  useSyncEnginePages: vi.fn(),
  useAdminSyncBlockTrigger: vi.fn(),
  useAdminSyncBlockPause: vi.fn(),
  useAdminSyncBlockResume: vi.fn(),
  useAdminSyncBlockReset: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => queries);
vi.mock("../apps/dashboard/node_modules/sonner/dist/index.mjs", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { getSyncBlockActionPresentation } from "../apps/dashboard/src/pages/settings/sync/SyncBlockActions.tsx";
import { engineAgeText, formatEngineSummaryLine } from "../apps/dashboard/src/pages/settings/sync/SyncEngineCard.tsx";
import {
  formatBlockSummary,
  getBlockStateLabel,
  needsVisualAttention,
} from "../apps/dashboard/src/pages/settings/sync/syncBlockDisplay.ts";
import { SyncPageDetail } from "../apps/dashboard/src/pages/settings/sync/SyncPageDetail.tsx";
import { SyncPageList } from "../apps/dashboard/src/pages/settings/sync/SyncPageList.tsx";

// The Settings "Синхронизация" tab for a page the Fansly Sync Engine owns
// (design step 3 §3.2 item 3): it says who serves the page, shows the
// engine's own status, and its buttons act on the engine.

const MANAGED = "Управляется Fansly Sync Engine";
const NOW = "2026-10-02T12:00:00.000Z";

function engineBlock(
  key: SyncBlockStatus["block"],
  overrides: Partial<SyncBlockStatus> = {},
  metrics: Record<string, unknown> = {},
): SyncBlockStatus {
  return {
    block: key,
    state: "engine",
    engineMode: "live",
    succeededAt: "2026-10-02T11:58:00.000Z",
    progress: null,
    progressStream: null,
    progressRole: null,
    error: null,
    statusReason: { code: "fansly_sync_engine", summary: "Managed by the Fansly Sync Engine", waitingFor: null },
    primaryFresh: true,
    needsAttention: false,
    nextDueAt: null,
    nextRetryAt: null,
    intervals: [],
    metrics: { engineMode: "live", engineKeys: ["transactions.head", "transactions.insurance"], pausedResources: [], pausedAll: false, ...metrics },
    connectionStatus: key === "connection" ? "connected" : null,
    substreams: [{
      stream: "transactions",
      role: "primary",
      state: "engine",
      succeededAt: "2026-10-02T11:58:00.000Z",
      nextDueAt: "2026-10-02T12:03:00.000Z",
      nextRetryAt: null,
      cadenceSeconds: 300,
      isFresh: true,
      needsAttention: false,
      statusReason: { code: "not_due", summary: "transactions.insurance: not_due", waitingFor: null },
      error: null,
    }, {
      stream: "top_spenders",
      role: "supporting",
      state: "engine",
      succeededAt: null,
      nextDueAt: null,
      nextRetryAt: null,
      cadenceSeconds: 21_600,
      isFresh: true,
      needsAttention: false,
      statusReason: { code: "paused", summary: "top-spenders.window: paused", waitingFor: null },
      error: null,
    }],
    ...overrides,
  };
}

function page(blockOverrides: Partial<SyncBlockStatus> = {}): SyncBlocksPage {
  return {
    pageId: 4,
    pageLabel: "lilly-1",
    platform: "fansly",
    modelSlug: "lilly",
    modelName: "Lilly",
    username: "lilly",
    displayName: null,
    diagnosis: null,
    blocks: {
      connection: engineBlock("connection"),
      financials: engineBlock("financials", blockOverrides),
      audience: engineBlock("audience"),
      messages_live: engineBlock("messages_live"),
      messages_history: engineBlock("messages_history"),
    },
  };
}

function status(overrides: Partial<AgentSyncPageStatus> = {}): AgentSyncPageStatus {
  const queue = { runnable: 0, waitingByReason: {} };
  return {
    pageLabel: "lilly-1",
    mode: "live",
    owner: { generation: "4", host: "sync-1", acquiredAt: NOW, heartbeatAt: NOW, running: true },
    pause: { settingMs: 2500, lastSendAt: NOW, minGapLastHourMs: 2600, violationsLastDay: 0 },
    sendsLastHour: { urgent: 12, requests: 0, planned: 30, byResource: {} },
    queue: {
      urgent: { runnable: 1, waitingByReason: { not_due: 2 } },
      requests: queue,
      planned: { runnable: 0, waitingByReason: { not_due: 20, paused: 3 } },
    },
    holds: { page: null, resources: [] },
    breakers: { open: 0, blockedByVendor: 0 },
    quarantined: 0,
    requests: [],
    ws: { connected: true, since: NOW, gapSince: NOW, decodeDebt: 0 },
    shadow: null,
    ...overrides,
  };
}

function renderRouted(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, element));
}

beforeEach(() => {
  for (const hook of ["useAdminSyncBlockTrigger", "useAdminSyncBlockPause", "useAdminSyncBlockResume",
    "useAdminSyncBlockReset"] as const) queries[hook].mockReturnValue(mutation());
  queries.useSyncEnginePages.mockReturnValue({ data: { pages: [status()] } });
});

describe("an engine page on the Sync tab", () => {
  it("speaks for the engine instead of the frozen legacy streams", () => {
    const block = page().blocks.financials;
    expect(getBlockStateLabel(block)).toBe("Sync Engine");
    expect(formatBlockSummary(block)).toMatch(/^Fansly Sync Engine · updated /);
    expect(needsVisualAttention(block)).toBe(false);
    const quarantined = engineBlock("financials", {
      needsAttention: true,
      primaryFresh: false,
      statusReason: { code: "engine_quarantined", summary: "1 quarantined (transactions.rescan)", waitingFor: null },
    });
    expect(getBlockStateLabel(quarantined)).toBe("Attention");
    expect(formatBlockSummary(quarantined)).toBe("Fansly Sync Engine · quarantined");
    expect(needsVisualAttention(quarantined)).toBe(true);
    expect(formatBlockSummary(engineBlock("financials", { engineMode: "handover" }))).toBe("Switching to the Fansly Sync Engine");
  });

  it("the overview card says who serves the page, with the engine's status line", () => {
    queries.useSyncOverview.mockReturnValue({
      data: { generatedAt: NOW, diagnosis: null, pages: [page()] },
      isLoading: false, isError: false, error: null,
    });
    const html = renderRouted(createElement(SyncPageList, { onSelectPage: vi.fn() }));
    expect(html).toContain(MANAGED);
    expect(html).toContain("владелец отвечал");
    expect(html).toContain("сокет подключён");
    expect(html).not.toContain("Delayed");
  });

  it("the page detail shows the engine card with its queue by why it waits", () => {
    queries.usePageSyncBlocks.mockReturnValue({
      data: { generatedAt: NOW, page: page() },
      isLoading: false, isError: false, error: null,
    });
    const html = renderRouted(createElement(SyncPageDetail, { pageLabel: "lilly-1", onBack: vi.fn() }));
    expect(html).toContain(MANAGED);
    expect(html).toContain("ждёт срока: 20");
    expect(html).toContain("пауза владельца: 3");
    expect(html).toContain("2500 мс");
    // The legacy streams' rows read the engine's reasons.
    expect(html).toContain("Not due");
    expect(html).toContain("Paused");
  });

  it("a session without the engine status still sees who serves the page", () => {
    queries.useSyncEnginePages.mockReturnValue({ data: undefined });
    queries.usePageSyncBlocks.mockReturnValue({
      data: { generatedAt: NOW, page: page() },
      isLoading: false, isError: false, error: null,
    });
    const html = renderRouted(createElement(SyncPageDetail, { pageLabel: "lilly-1", onBack: vi.fn() }));
    expect(html).toContain(MANAGED);
    expect(html).toContain("Подробности движка недоступны");
  });

  it("the buttons act on the engine: sync now only while live, pause/resume by the block's keys, requeue on a quarantine", () => {
    expect(getSyncBlockActionPresentation(page().blocks.financials, "fansly")).toEqual({
      showTrigger: true,
      showPause: true,
      showResume: false,
      showReset: false,
      resumeLabel: "Resume",
      resetLabel: "Requeue",
    });
    const paused = engineBlock("financials", {}, { pausedResources: ["transactions.head", "transactions.insurance"] });
    expect(getSyncBlockActionPresentation(paused, "fansly")).toMatchObject({ showPause: false, showResume: true });
    const partly = engineBlock("financials", {}, { pausedResources: ["transactions.head"] });
    expect(getSyncBlockActionPresentation(partly, "fansly")).toMatchObject({ showPause: true, showResume: true });
    const handover = engineBlock("financials", { engineMode: "handover", needsAttention: true });
    expect(getSyncBlockActionPresentation(handover, "fansly")).toMatchObject({ showTrigger: false, showReset: false });
    const quarantined = engineBlock("financials", { needsAttention: true });
    expect(getSyncBlockActionPresentation(quarantined, "fansly")).toMatchObject({ showReset: true, resetLabel: "Requeue" });
  });

  it("formats the engine line and ages in the owner's words", () => {
    const now = new Date(NOW).getTime();
    expect(engineAgeText("2026-10-02T11:59:48.000Z", now)).toBe("12 с");
    expect(engineAgeText("2026-10-02T11:50:00.000Z", now)).toBe("10 мин");
    expect(engineAgeText("2026-10-02T06:00:00.000Z", now)).toBe("6 ч");
    expect(engineAgeText(null, now)).toBeNull();
    expect(formatEngineSummaryLine(status({
      mode: "handover",
      owner: { generation: "4", host: null, acquiredAt: null, heartbeatAt: null, running: false },
      holds: { page: { kind: "auth", until: "infinity", since: NOW }, resources: [] },
      quarantined: 2,
      ws: null,
    }), now)).toBe(
      "переключение · владельца нет · сокет: нет данных · удержание: Fansly не принимает данные входа, до новых данных входа · в карантине: 2",
    );
  });
});
