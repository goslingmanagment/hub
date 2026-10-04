import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentHistoryRequest,
  AgentSyncPageStatus,
  SyncBlockStatus,
  SyncBlocksPage,
} from "@agency_hub_core/contracts";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

// Root tests cannot resolve @tanstack/react-query, so the api layer is mocked
// at module level (same pattern as dashboard-sync-surfaces.test.ts).
const mutation = () => ({ isPending: false, mutateAsync: vi.fn() });
const queries = vi.hoisted(() => ({
  useSyncOverview: vi.fn(),
  usePageSyncBlocks: vi.fn(),
  useSyncEnginePages: vi.fn(),
  useSyncHistoryRequests: vi.fn(),
  useAdminSyncBlockTrigger: vi.fn(),
  useAdminSyncBlockPause: vi.fn(),
  useAdminSyncBlockResume: vi.fn(),
  useAdminSyncBlockReset: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => queries);
vi.mock("../apps/dashboard/node_modules/sonner/dist/index.mjs", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { buildPageSyncRoute, buildSettingsRoute, syncSettingsTab } from "../apps/dashboard/src/lib/navigation.ts";
import { SettingsPage } from "../apps/dashboard/src/pages/SettingsPage.tsx";
import { EnginePageDetail } from "../apps/dashboard/src/pages/settings/engine/EnginePageDetail.tsx";
import { EnginePageList } from "../apps/dashboard/src/pages/settings/engine/EnginePageList.tsx";
import { EngineQueueTable, EngineStatusGrid } from "../apps/dashboard/src/pages/settings/engine/EngineStatus.tsx";
import { HistoryRequestCard, HistoryRequestsBlock } from "../apps/dashboard/src/pages/settings/engine/HistoryRequests.tsx";
import {
  engineAgeText,
  engineDurationText,
  engineSocketText,
  engineStatusState,
  historyEtaText,
  historyReadsText,
} from "../apps/dashboard/src/pages/settings/engine/engineDisplay.ts";
import { getSyncBlockActionPresentation } from "../apps/dashboard/src/pages/settings/sync/SyncBlockActions.tsx";
import {
  formatBlockSummary,
  getBlockStateLabel,
  needsVisualAttention,
} from "../apps/dashboard/src/pages/settings/sync/syncBlockDisplay.ts";
import { SyncPageDetail } from "../apps/dashboard/src/pages/settings/sync/SyncPageDetail.tsx";
import { SyncPageList } from "../apps/dashboard/src/pages/settings/sync/SyncPageList.tsx";

// The Settings «Синк» tab (step 4, S4-28; plan §10): every Fansly page as the
// Fansly Sync Engine reads it — owner, holds, socket, the pause, the queue with
// the hour's requests by class, and its history requests with their progress
// and ETA — and the five blocks whose buttons act on the engine. «Синхронизация»
// keeps the pages of the legacy executor only.

const NOW = "2026-10-02T12:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();
/** Thousands are grouped with a narrow no-break space (ru-RU). */
const plain = (html: string) => html.replace(/[\u00a0\u202f]/g, " ");

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

function page(overrides: Partial<SyncBlocksPage> = {}, blockOverrides: Partial<SyncBlockStatus> = {}): SyncBlocksPage {
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
    ...overrides,
  };
}

/** A page of the legacy executor, with the blocks «Синхронизация» shows. */
function legacyPage(overrides: Partial<SyncBlocksPage> = {}): SyncBlocksPage {
  const block = (key: SyncBlockStatus["block"]): SyncBlockStatus => {
    const { engineMode: _mode, ...rest } = engineBlock(key, { state: "up_to_date", statusReason: null, metrics: {}, substreams: [] });
    return rest;
  };
  return {
    ...page(),
    pageId: 8,
    pageLabel: "lora-of",
    platform: "onlyfans",
    username: "lora_of",
    blocks: {
      connection: block("connection"),
      financials: block("financials"),
      audience: block("audience"),
      messages_live: block("messages_live"),
      messages_history: block("messages_history"),
    },
    ...overrides,
  };
}

function status(overrides: Partial<AgentSyncPageStatus> = {}): AgentSyncPageStatus {
  return {
    pageLabel: "lilly-1",
    mode: "live",
    owner: { generation: "4", host: "sync-1", acquiredAt: NOW, heartbeatAt: NOW, running: true },
    pause: { settingMs: 2500, lastSendAt: NOW, minGapLastHourMs: 2600, violationsLastDay: 0 },
    sendsLastHour: { urgent: 12, requests: 1340, planned: 30, byResource: { "dm-messages.history": 1340, "transactions.head": 12, "account.poll": 30 } },
    queue: {
      urgent: { runnable: 1, waitingByReason: { not_due: 2 } },
      requests: { runnable: 4, waitingByReason: { pacer: 3, class_share: 1 } },
      planned: { runnable: 0, waitingByReason: { not_due: 20, paused: 3 } },
    },
    holds: { page: null, resources: [] },
    breakers: { open: 0, blockedByVendor: 0 },
    quarantined: 0,
    requests: [],
    ws: { connected: true, since: "2026-10-02T11:00:13.000Z", gapSince: "2026-10-02T11:00:00.000Z", decodeDebt: 0 },
    shadow: null,
    ...overrides,
  };
}

function historyRequest(overrides: Partial<AgentHistoryRequest> = {}): AgentHistoryRequest {
  return {
    ref: "11111111-1111-4111-8111-111111111111",
    pageLabel: "lilly-1",
    state: "open",
    depth: { kind: "all" },
    requesterKind: "agent_key",
    createdAt: "2026-10-02T10:00:00.000Z",
    doneAt: null,
    cancelledAt: null,
    counts: { total: 120, ready: 14, queued: 101, loading: 1, blocked: 2, refused: 2, cancelled: 0 },
    reads: { done: 340, remainingMin: 900, remainingEstimate: 1400 },
    eta: {
      lowerBoundSeconds: 4200,
      estimateSeconds: 7500,
      basis: "estimate",
      ratePerHour: 780,
      sharePercent: 40,
      limitedBy: "route",
      slowdown: null,
      hold: null,
    },
    queuePosition: 1,
    waitingReason: "pacer",
    waitingUntil: null,
    ...overrides,
  };
}

function loaded<T>(data: T) {
  return { data, isLoading: false, isError: false, error: null };
}

function renderRouted(element: ReturnType<typeof createElement>, initialEntries = ["/"]) {
  return plain(renderToStaticMarkup(createElement(MemoryRouter, { initialEntries }, element)));
}

/** The text of the cell that shows a class's requests of the hour. */
function sendsCell(html: string, workClass: string): string | undefined {
  return html.match(new RegExp(`data-sends-class="${workClass}"[^>]*>([^<]*)<`))?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const hook of ["useAdminSyncBlockTrigger", "useAdminSyncBlockPause", "useAdminSyncBlockResume",
    "useAdminSyncBlockReset"] as const) queries[hook].mockReturnValue(mutation());
  queries.useSyncOverview.mockReturnValue(loaded({ generatedAt: NOW, diagnosis: null, pages: [page(), legacyPage()] }));
  queries.usePageSyncBlocks.mockReturnValue(loaded({ generatedAt: NOW, page: page() }));
  queries.useSyncEnginePages.mockReturnValue(loaded({ pages: [status()] }));
  queries.useSyncHistoryRequests.mockReturnValue(loaded({ requests: [] }));
});

describe("where a page's sync is shown", () => {
  it("a Fansly page is on «Синк», every other page on «Синхронизация»", () => {
    expect(syncSettingsTab("fansly")).toBe("engine");
    expect(syncSettingsTab("onlyfans")).toBe("sync");
    expect(buildPageSyncRoute("fansly", "lilly-1")).toBe("/settings?tab=engine&page=lilly-1");
    expect(buildPageSyncRoute("onlyfans", "lora/of")).toBe("/settings?tab=sync&page=lora%2Fof");
    expect(buildSettingsRoute("engine")).toBe("/settings?tab=engine");
  });

  it("Settings has the «Синк» section, and «Синхронизация» says it is about OnlyFans", () => {
    const html = renderRouted(createElement(SettingsPage), ["/settings?tab=engine"]);
    expect(html).toContain(">Синк</a>");
    expect(html).toContain("как Fansly Sync Engine читает каждую страницу Fansly");
    expect(html).toContain('data-engine-page="lilly-1"');
    const sync = renderRouted(createElement(SettingsPage), ["/settings?tab=sync"]);
    expect(sync).toContain("какие данные OnlyFans обновляются");
    expect(sync).not.toContain("data-engine-page");
  });
});

describe("the «Синк» tab: the list of Fansly pages", () => {
  it("lists the Fansly pages only, each with the engine's status, and points to the other tab for the rest", () => {
    const html = renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }));
    expect(html).toContain('data-engine-page="lilly-1"');
    expect(html).not.toContain("lora-of");
    expect(html).toContain("владелец отвечал");
    expect(html).toContain("подключён");
    expect(html).toContain("2 500 мс");
    expect(html).toContain("наименьший промежуток за час 2 600 мс");
    expect(html).toContain("ждёт срока: 20");
    expect(html).toContain("пауза владельца: 3");
    // Its five blocks at a glance, in the engine's words.
    expect(html.match(/Fansly Sync Engine · updated/g)).toHaveLength(5);
    expect(html).toContain("Остальные страницы (1)");
    expect(html).toContain('href="/settings?tab=sync"');
    expect(queries.useSyncHistoryRequests).toHaveBeenCalledWith({ state: "open", limit: 200 });
  });

  it("shows the hour's requests of each class and their total", () => {
    const html = renderRouted(createElement(EngineQueueTable, { status: status() }));
    expect(sendsCell(html, "urgent")).toBe("12");
    expect(sendsCell(html, "requests")).toBe("1 340");
    expect(sendsCell(html, "planned")).toBe("30");
    expect(sendsCell(html, "all")).toBe("1 382");
    // A row that only waits for its turn is ready to run, not "waiting".
    expect(html).not.toContain("пауза между запросами");
    expect(html).not.toContain("очередь класса");
    // Each page of the list carries its own counts.
    queries.useSyncOverview.mockReturnValue(loaded({
      generatedAt: NOW, diagnosis: null, pages: [page(), page({ pageId: 5, pageLabel: "lilly-2" })],
    }));
    queries.useSyncEnginePages.mockReturnValue(loaded({
      pages: [status(), status({ pageLabel: "lilly-2", sendsLastHour: { urgent: 1, requests: 0, planned: 7, byResource: {} } })],
    }));
    const list = renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }));
    const second = list.slice(list.indexOf('data-engine-page="lilly-2"'));
    expect(sendsCell(second, "urgent")).toBe("1");
    expect(sendsCell(second, "planned")).toBe("7");
    expect(sendsCell(second, "all")).toBe("8");
  });

  it("shows what holds a page, its breakers and its quarantine", () => {
    const held = status({
      owner: { generation: "4", host: null, acquiredAt: null, heartbeatAt: null, running: false },
      pause: { settingMs: 2000, lastSendAt: null, minGapLastHourMs: 1500, violationsLastDay: 2 },
      holds: {
        page: { kind: "auth", until: "infinity", since: NOW },
        resources: [{ file: "probe", until: "2026-10-02T18:00:00.000Z", step: 8, kind: "breaker" }],
      },
      breakers: { open: 3, blockedByVendor: 1 },
      quarantined: 2,
      ws: { connected: false, since: null, gapSince: null, decodeDebt: 0 },
    });
    const html = renderRouted(createElement(EngineStatusGrid, { status: held, pageLabel: "lilly-1", now: NOW_MS }));
    expect(html).toContain("владельца нет");
    expect(html).toContain("Fansly не принимает данные входа, до новых данных входа");
    expect(html).toMatch(/probe до \d/);
    expect(html).toContain("отключён");
    expect(html).toContain("нарушений за сутки: 2");
    expect(html).toContain("не было");
    expect(html).toContain("пауза после ошибок: 3 · Fansly отказывает: 1");
    expect(html).toContain("pnpm cli sync work list --page lilly-1 --state quarantined");
  });

  it("a Fansly page no engine reads says so and keeps its blocks; a failed status read says that instead", () => {
    queries.useSyncEnginePages.mockReturnValue(loaded({ pages: [] }));
    const absent = renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }));
    expect(absent).toContain("Fansly Sync Engine не читает эту страницу");
    expect(absent).not.toContain("Запросов за час");
    expect(absent).toContain("Connection");
    queries.useSyncEnginePages.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error("403") });
    const failed = renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }));
    expect(failed).toContain("Состояние движка не загрузилось.");
    expect(failed).not.toContain("не читает эту страницу");
  });

  it("a page the engine holds in a mode it sends nothing in reads as not read, with its mode", () => {
    queries.useSyncEnginePages.mockReturnValue(loaded({
      pages: [status({ mode: "off", ws: null, shadow: { attemptsLastHour: 40, demandVsEstimate: null } })],
    }));
    const html = renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }));
    expect(html).toContain("Fansly Sync Engine не читает эту страницу");
    expect(html).toContain(">off<");
    // Its journal is the shadow one: no queue and no requests of the hour.
    expect(html).not.toContain("Запросов за час");
    expect(engineStatusState(status({ mode: "shadow" }))).toEqual({ kind: "idle", mode: "shadow" });
    expect(engineStatusState(status({ mode: "handover" })).kind).toBe("ready");
    expect(engineStatusState(undefined)).toEqual({ kind: "idle", mode: null });
  });

  it("says when there is no Fansly page, and when the overview did not load", () => {
    queries.useSyncOverview.mockReturnValue(loaded({ generatedAt: NOW, diagnosis: null, pages: [legacyPage()] }));
    expect(renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }))).toContain("Страниц Fansly нет");
    queries.useSyncOverview.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error("Sync API unavailable") });
    const failed = renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }));
    expect(failed).toContain("Страницы не загрузились");
    expect(failed).toContain("Sync API unavailable");
  });
});

describe("the «Синк» tab: history requests", () => {
  it("an open request shows its fans, its reads and both numbers of its time", () => {
    const html = plain(renderToStaticMarkup(createElement("ul", null,
      createElement(HistoryRequestCard, { request: historyRequest(), now: NOW_MS }))));
    expect(html).toContain("вся история");
    expect(html).toContain("агент");
    expect(html).toContain("подана 2 ч назад");
    // The start of its ref, the whole one on hover (the CLI takes it).
    expect(html).toContain('title="11111111-1111-4111-8111-111111111111">11111111<');
    expect(html).toContain("№ 1 в очереди страницы");
    expect(html).toContain("готово 14 из 120 фанов · читается 1 · в очереди 101 · Fansly отказывает 2 · отклонено 2");
    expect(html).toContain('aria-valuenow="14"');
    expect(html).toContain('aria-valuemax="120"');
    expect(html).toMatch(/width:11\.6\d+%/);
    expect(html).toContain("сделано 340 · осталось не меньше 900, по оценке 1 400");
    expect(html).toContain("не меньше 1 ч 10 мин, по оценке 2 ч 5 мин");
    expect(html).toContain(">оценка<");
    expect(html).toContain("780 чтений в час · доля заявок 40 % · ограничивает лимит чтения сообщений");
    expect(html).toContain("пауза между запросами");
  });

  it("a chat too small to estimate has a lower bound and no estimate", () => {
    const request = historyRequest({
      depth: { kind: "latest", count: 200 },
      requesterKind: "owner_session",
      reads: { done: 0, remainingMin: 3, remainingEstimate: null },
      eta: { ...historyRequest().eta, lowerBoundSeconds: 45, estimateSeconds: null, limitedBy: "page" },
    });
    expect(historyReadsText(request)).toBe("сделано 0 · осталось не меньше 3, оценки нет");
    expect(historyEtaText(request)).toBe("не меньше 45 с, оценки нет");
    const html = plain(renderToStaticMarkup(createElement("ul", null, createElement(HistoryRequestCard, { request, now: NOW_MS }))));
    expect(html).toContain("последние 200 сообщений");
    expect(html).toContain("владелец");
    expect(html).toContain("ограничивает пауза страницы");
  });

  it("a hold and a slowdown stand apart from the time", () => {
    const held = historyRequest({
      eta: {
        ...historyRequest().eta,
        hold: { scope: "route", until: "2026-10-02T12:05:00.000Z" },
        slowdown: { route: "messages.page", effectivePerMin: 7.5, currentPerMin: 15 },
      },
    });
    const html = plain(renderToStaticMarkup(createElement("ul", null, createElement(HistoryRequestCard, { request: held, now: NOW_MS }))));
    expect(html).toMatch(/Удержание чтения сообщений до \d[^<]*: чтения стоят, в оценку времени оно не входит/);
    expect(html).toContain("Чтение замедлено после 429: 7,5 в минуту вместо 15 (уже в оценке)");
    // The seconds are the server's: the hold changes no number here.
    expect(html).toContain("не меньше 1 ч 10 мин, по оценке 2 ч 5 мин");
    const pageHeld = historyRequest({ eta: { ...historyRequest().eta, hold: { scope: "page", until: null } } });
    expect(plain(renderToStaticMarkup(createElement("ul", null, createElement(HistoryRequestCard, { request: pageHeld, now: NOW_MS })))))
      .toContain("Удержание страницы без срока: чтения стоят");
  });

  it("a closed request shows how it ended, with no time left", () => {
    const done = historyRequest({
      state: "done",
      doneAt: "2026-10-02T11:55:00.000Z",
      requesterKind: "legacy_hydration_wrapper",
      depth: { kind: "before_boundary", boundaryAt: null, boundaryMessageRef: null },
      counts: { total: 1, ready: 1, queued: 0, loading: 0, blocked: 0, refused: 0, cancelled: 0 },
      reads: { done: 12, remainingMin: 0, remainingEstimate: 0 },
      queuePosition: null,
      waitingReason: null,
    });
    const html = plain(renderToStaticMarkup(createElement("ul", null, createElement(HistoryRequestCard, { request: done, now: NOW_MS }))));
    expect(html).toContain("до прежней границы");
    expect(html).toContain("старый маршрут заявок");
    expect(html).toContain("выполнена 5 мин назад");
    expect(html).toContain("готово 1 из 1 фанов");
    expect(html).toContain(">сделано 12<");
    expect(html).not.toContain("не меньше");
    expect(html).not.toContain("чтений в час");
    const cancelled = historyRequest({ state: "cancelled", cancelledAt: "2026-10-02T11:00:00.000Z", queuePosition: null });
    expect(plain(renderToStaticMarkup(createElement("ul", null, createElement(HistoryRequestCard, { request: cancelled, now: NOW_MS })))))
      .toContain("отменена 60 мин назад");
  });

  it("lists a page's open requests in the order the page serves them, caps a card and says how many are left", () => {
    const requests = [
      historyRequest({ ref: "33333333-3333-4333-8333-333333333333", queuePosition: 3, depth: { kind: "latest", count: 30 } }),
      historyRequest({ ref: "11111111-1111-4111-8111-111111111111", queuePosition: 1 }),
      historyRequest({ ref: "22222222-2222-4222-8222-222222222222", queuePosition: 2, depth: { kind: "latest", count: 20 } }),
    ];
    const state = { requests, isLoading: false, isError: false };
    const all = plain(renderToStaticMarkup(createElement(HistoryRequestsBlock, { state, now: NOW_MS })));
    expect(all).toContain("Заявки на историю · открыто 3");
    expect([...all.matchAll(/data-history-request="(\d)/g)].map((match) => match[1])).toEqual(["1", "2", "3"]);
    const capped = plain(renderToStaticMarkup(createElement(HistoryRequestsBlock, {
      state, limit: 2, more: createElement("span", null, "все заявки страницы"), now: NOW_MS,
    })));
    expect([...capped.matchAll(/data-history-request="(\d)/g)].map((match) => match[1])).toEqual(["1", "2"]);
    expect(capped).toContain("Ещё 1");
    expect(capped).toContain("все заявки страницы");
  });

  it("says when a page has no open request, and when the requests are not there to show", () => {
    const render = (state: Parameters<typeof HistoryRequestsBlock>[0]["state"]) =>
      plain(renderToStaticMarkup(createElement(HistoryRequestsBlock, { state })));
    expect(render({ requests: [], isLoading: false, isError: false })).toContain("Открытых заявок нет.");
    expect(render({ requests: undefined, isLoading: true, isError: false })).toContain("Загружаем заявки…");
    expect(render({ requests: undefined, isLoading: false, isError: true })).toContain("Заявки не загрузились.");
    expect(render({ requests: undefined, isLoading: false, isError: false })).toContain("Заявки недоступны.");
  });

  it("each page of the list shows its own open requests", () => {
    queries.useSyncOverview.mockReturnValue(loaded({
      generatedAt: NOW, diagnosis: null, pages: [page(), page({ pageId: 5, pageLabel: "lilly-2" })],
    }));
    queries.useSyncHistoryRequests.mockReturnValue(loaded({ requests: [historyRequest({ pageLabel: "lilly-2" })] }));
    const html = renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }));
    const [first, second] = html.split('data-engine-page="lilly-2"');
    expect(first).toContain("Открытых заявок нет.");
    expect(second).toContain("Заявки на историю · открыто 1");
    expect(second).toContain("готово 14 из 120 фанов");
  });
});

describe("the «Синк» tab: a page in detail", () => {
  it("shows the status with the hour's requests by resource, every open request and the ones that ended lately", () => {
    const closed = historyRequest({
      ref: "99999999-9999-4999-8999-999999999999", state: "done", doneAt: "2026-10-02T11:55:00.000Z", queuePosition: null,
    });
    queries.useSyncHistoryRequests.mockImplementation((query: { state?: string }) =>
      loaded({ requests: query.state === "open" ? [historyRequest()] : [historyRequest(), closed] }));
    const html = renderRouted(createElement(EnginePageDetail, { pageLabel: "lilly-1", onBack: vi.fn() }));
    expect(html).toContain("К списку страниц");
    expect(html).toContain("владелец отвечал");
    expect(html).toContain("Запросов за час по ресурсам");
    expect(html.indexOf("dm-messages.history")).toBeLessThan(html.indexOf("account.poll"));
    expect(html).toContain("Заявки на историю · открыто 1");
    expect(html).toContain("Недавно закрытые");
    expect(html.match(/data-history-request=/g)).toHaveLength(2);
    expect(queries.useSyncHistoryRequests).toHaveBeenCalledWith({ pageLabel: "lilly-1", state: "open", limit: 200 }, { enabled: true });
    expect(queries.useSyncHistoryRequests).toHaveBeenCalledWith({ pageLabel: "lilly-1", limit: 20 }, { enabled: true });
  });

  it("keeps the five blocks, their streams in the engine's words and the buttons that act on the engine", () => {
    const html = renderRouted(createElement(EnginePageDetail, { pageLabel: "lilly-1", onBack: vi.fn() }));
    for (const label of ["Connection", "Financials", "Audience", "Messages Live", "Messages History"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Not due");
    expect(html).toContain("Paused");
    expect(html).toContain("Sync Now");
  });

  it("a stream the engine reads on a trigger, not on a poll, shows no interval", () => {
    const blocks = page();
    const reconcile = { ...blocks.blocks.audience.substreams[1]!, stream: "followers_reconcile" as const, cadenceSeconds: 0 };
    blocks.blocks.audience = engineBlock("audience", { substreams: [blocks.blocks.audience.substreams[0]!, reconcile] });
    queries.usePageSyncBlocks.mockReturnValue(loaded({ generatedAt: NOW, page: blocks }));
    const html = renderRouted(createElement(EnginePageDetail, { pageLabel: "lilly-1", onBack: vi.fn() }));
    expect(html).toContain("follower reconcile");
    expect(html).not.toMatch(/>0s</);
  });

  // Step 4, S4-24: a Fansly page the engine does not own has no legacy block
  // to show: every block is not available and says that nothing reads the page.
  it("a Fansly page the engine does not own says why its blocks are not available, with no button", () => {
    const unserved = (key: SyncBlockStatus["block"]): SyncBlockStatus => ({
      ...engineBlock(key),
      state: "not_available",
      succeededAt: null,
      statusReason: {
        code: "fansly_sync_engine_off",
        summary: "The Fansly Sync Engine does not run this page: nothing reads it.",
        waitingFor: null,
      },
      primaryFresh: false,
      metrics: {},
      connectionStatus: null,
      substreams: [],
    });
    const { engineMode: _mode, ...connection } = unserved("connection");
    const blocks = {
      connection: connection as SyncBlockStatus,
      financials: unserved("financials"),
      audience: unserved("audience"),
      messages_live: unserved("messages_live"),
      messages_history: unserved("messages_history"),
    };
    queries.usePageSyncBlocks.mockReturnValue(loaded({ generatedAt: NOW, page: { ...page(), blocks } }));
    queries.useSyncEnginePages.mockReturnValue(loaded({ pages: [] }));
    const html = renderRouted(createElement(EnginePageDetail, { pageLabel: "lilly-1", onBack: vi.fn() }));
    expect(html.match(/The Fansly Sync Engine does not run this page: nothing reads it\./g)).toHaveLength(5);
    expect(html).toContain("Fansly Sync Engine не читает эту страницу");
    expect(html).not.toContain("Not available on this platform");
    expect(html).not.toContain("Sync Now");
    expect(html).not.toContain("Pause");
    expect(formatBlockSummary(blocks.financials)).toBe("Not available");
    expect(needsVisualAttention(blocks.financials)).toBe(false);
  });

  it("a page of the legacy executor opened here points to «Синхронизация» and reads no request", () => {
    queries.usePageSyncBlocks.mockReturnValue(loaded({ generatedAt: NOW, page: legacyPage() }));
    const html = renderRouted(createElement(EnginePageDetail, { pageLabel: "lora-of", onBack: vi.fn() }));
    expect(html).toContain("Страницу lora-of Fansly Sync Engine не читает");
    expect(html).toContain('href="/settings?tab=sync&amp;page=lora-of"');
    expect(html).not.toContain("Заявки на историю");
    expect(html).not.toContain("Financials");
    expect(queries.useSyncHistoryRequests).toHaveBeenCalledWith(expect.anything(), { enabled: false });
  });

  it("says when the page did not load", () => {
    queries.usePageSyncBlocks.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error("Details API unavailable") });
    const html = renderRouted(createElement(EnginePageDetail, { pageLabel: "lilly-1", onBack: vi.fn() }));
    expect(html).toContain("Страница не загрузилась");
    expect(html).toContain("Details API unavailable");
  });
});

describe("«Синхронизация» keeps the pages of the legacy executor only", () => {
  it("lists no Fansly page, shows no engine status and says where the Fansly pages are", () => {
    const html = renderRouted(createElement(SyncPageList, { onSelectPage: vi.fn() }));
    expect(html).toContain("lora-of");
    expect(html).not.toContain("lilly-1");
    expect(html).not.toContain("Fansly Sync Engine ·");
    expect(html).toContain("Страницы Fansly (1) читает Fansly Sync Engine");
    expect(html).toContain('href="/settings?tab=engine"');
    expect(queries.useSyncEnginePages).not.toHaveBeenCalled();
    expect(queries.useSyncHistoryRequests).not.toHaveBeenCalled();
  });

  it("with Fansly pages only, it shows the pointer instead of an empty list", () => {
    queries.useSyncOverview.mockReturnValue(loaded({ generatedAt: NOW, diagnosis: null, pages: [page()] }));
    const html = renderRouted(createElement(SyncPageList, { onSelectPage: vi.fn() }));
    expect(html).toContain("Страницы Fansly (1) читает Fansly Sync Engine");
    expect(html).not.toContain("No pages configured");
  });

  it("speaks for its own pages: a Fansly page's diagnosis is not its headline", () => {
    const diagnosis = {
      code: "auth_blocked" as const, severity: "error" as const, headline: "Reconnect credentials",
      detail: "Fansly refuses the session.", actionKind: "credentials" as const,
    };
    queries.useSyncOverview.mockReturnValue(loaded({
      generatedAt: NOW, diagnosis, pages: [page({ diagnosis }), legacyPage()],
    }));
    expect(renderRouted(createElement(SyncPageList, { onSelectPage: vi.fn() }))).not.toContain("Reconnect credentials");
    // The page's own tab shows it.
    expect(renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }))).toContain("Reconnect credentials");
  });

  it("a Fansly page opened here points to «Синк»", () => {
    const html = renderRouted(createElement(SyncPageDetail, { pageLabel: "lilly-1", onBack: vi.fn() }));
    expect(html).toContain("Страницу lilly-1 читает Fansly Sync Engine");
    expect(html).toContain('href="/settings?tab=engine&amp;page=lilly-1"');
    expect(html).not.toContain("Financials");
    expect(html).not.toContain("Sync Now");
  });
});

describe("the engine's blocks and buttons", () => {
  it("speak for the engine instead of the frozen legacy streams", () => {
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
    // What needs the owner is on the page's card of the list.
    queries.useSyncOverview.mockReturnValue(loaded({
      generatedAt: NOW, diagnosis: null, pages: [page({}, quarantined)],
    }));
    expect(renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }))).toContain("1 quarantined (transactions.rescan)");
  });

  it("the buttons act on the engine: sync now only while live, pause/resume by the block's keys, requeue on a quarantine", () => {
    expect(getSyncBlockActionPresentation(page().blocks.financials)).toEqual({
      showTrigger: true,
      showPause: true,
      showResume: false,
      showReset: false,
      resumeLabel: "Resume",
      resetLabel: "Requeue",
    });
    const paused = engineBlock("financials", {}, { pausedResources: ["transactions.head", "transactions.insurance"] });
    expect(getSyncBlockActionPresentation(paused)).toMatchObject({ showPause: false, showResume: true });
    const partly = engineBlock("financials", {}, { pausedResources: ["transactions.head"] });
    expect(getSyncBlockActionPresentation(partly)).toMatchObject({ showPause: true, showResume: true });
    const handover = engineBlock("financials", { engineMode: "handover", needsAttention: true });
    expect(getSyncBlockActionPresentation(handover)).toMatchObject({ showTrigger: false, showReset: false });
    const quarantined = engineBlock("financials", { needsAttention: true });
    expect(getSyncBlockActionPresentation(quarantined)).toMatchObject({ showReset: true, resetLabel: "Requeue" });
  });
});

describe("the tab's words", () => {
  it("ages, spans and the socket in the owner's words", () => {
    expect(engineAgeText("2026-10-02T11:59:48.000Z", NOW_MS)).toBe("12 с");
    expect(engineAgeText("2026-10-02T11:50:00.000Z", NOW_MS)).toBe("10 мин");
    expect(engineAgeText("2026-10-02T06:00:00.000Z", NOW_MS)).toBe("6 ч");
    expect(engineAgeText(null, NOW_MS)).toBeNull();
    // A span is rounded down: a lower bound stays one.
    expect(engineDurationText(59.9)).toBe("59 с");
    expect(engineDurationText(3599)).toBe("59 мин");
    expect(engineDurationText(3600)).toBe("1 ч");
    expect(engineDurationText(7199)).toBe("1 ч 59 мин");
    expect(engineDurationText(86_400)).toBe("1 сут");
    expect(engineDurationText(183_600)).toBe("2 сут 3 ч");
    // `gapSince` is the gap the connection opened with: how long intake had
    // stopped before it, not a break in the socket that runs.
    expect(engineSocketText(status())).toMatch(/^подключён · с \d[^·]* · перерыв приёма перед этим 13 с$/);
    expect(engineSocketText(status({ ws: { connected: true, since: NOW, gapSince: NOW, decodeDebt: 4 } })))
      .toMatch(/^подключён · с \d[^·]* · не разобрано кадров: 4$/);
    expect(engineSocketText(status({ ws: { connected: false, since: NOW, gapSince: NOW, decodeDebt: 0 } })))
      .toMatch(/^отключён · последнее подключение в \d/);
    expect(engineSocketText(status({ ws: null }))).toBe("нет данных");
  });
});
