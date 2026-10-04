import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

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
  engineOwnerText,
  engineSocketText,
  engineStatusState,
  engineWaitLabel,
  engineWaitWords,
  engineWaitingText,
  historyEtaText,
  historyFansText,
  historyReadsText,
} from "../apps/dashboard/src/pages/settings/engine/engineDisplay.ts";
import { EngineBlockCard, EngineBlockRow, EnginePageAttention } from "../apps/dashboard/src/pages/settings/engine/EngineBlocks.tsx";
import { EngineModeChip } from "../apps/dashboard/src/pages/settings/engine/EngineStatus.tsx";
import {
  engineBlockButtons,
  engineBlockState,
  engineBlockSummary,
  engineLeverNotice,
  engineRequeueConfirmText,
  engineSubstreamStateText,
  isEngineBlock,
  type EngineBlock,
} from "../apps/dashboard/src/pages/settings/engine/engineBlockDisplay.ts";
import { formatBlockSummary, needsVisualAttention } from "../apps/dashboard/src/pages/settings/sync/syncBlockDisplay.ts";
import { SyncPageDetail } from "../apps/dashboard/src/pages/settings/sync/SyncPageDetail.tsx";
import { SyncPageList } from "../apps/dashboard/src/pages/settings/sync/SyncPageList.tsx";
import { WAITING_REASONS, isRunnableReason } from "../apps/runtime/src/sync/engine/status.ts";

// The Settings «Синк» tab (step 4, S4-28; plan §10): every Fansly page as the
// Fansly Sync Engine reads it — owner, holds, socket, the pause, the queue with
// the hour's requests by class, and its history requests with their progress
// and ETA — and the five blocks whose buttons act on the engine. «Синхронизация»
// keeps the pages of the legacy executor only. Since S4-35 the blocks say what
// is true of them — read, paused, held, without an owner — in the tab's own
// language, and a button says what it moved.

const NOW = "2026-10-02T12:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();
/** Thousands are grouped with a narrow no-break space (ru-RU). */
const plain = (html: string) => html.replace(/[\u00a0\u202f]/g, " ");

type EngineInfo = NonNullable<SyncBlockStatus["engine"]>;
type EngineStop = EngineInfo["stops"][number];

const FINANCIALS_KEYS = [
  "transactions.head", "transactions.insurance", "transactions.rescan", "transactions.backfill",
  "top-spenders.window", "top-spenders.bootstrap",
];

const stop = (reason: EngineStop["reason"], by: string[], resources: string[], until: string | null = null): EngineStop =>
  ({ reason, by, resources, until });

/** A block of a page the engine reads, with nothing stopping it; `engine`
 *  overrides what the server says of its keys. */
function engineBlock(
  key: SyncBlockStatus["block"],
  overrides: Partial<SyncBlockStatus> = {},
  engine: Partial<EngineInfo> = {},
): EngineBlock {
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
    nextDueAt: "2026-10-02T12:03:00.000Z",
    nextRetryAt: null,
    intervals: [{ stream: "transactions", cadenceSeconds: 300 }],
    metrics: {},
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
      engine: { stopped: "none", stops: [], paused: false, activeWork: 3 },
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
      engine: {
        stopped: "all", paused: true, activeWork: 1,
        stops: [stop("paused", ["keys"], ["top-spenders.window", "top-spenders.bootstrap"])],
      },
    }],
    ...overrides,
    engine: {
      mode: "live",
      ownerRunning: true,
      keys: FINANCIALS_KEYS,
      pollKeys: ["transactions.insurance", "transactions.rescan", "top-spenders.window"],
      pausedKeys: [],
      pausedAll: false,
      stopped: "none",
      stops: [],
      paused: false,
      activeWork: 4,
      quarantined: { count: 0, resources: [] },
      blockedByVendor: { count: 0, resources: [] },
      ...overrides.engine,
      ...engine,
    },
  };
}

/** What the server says of a block all of whose keys the owner paused. */
const allPaused = (keys: string[] = FINANCIALS_KEYS): Partial<EngineInfo> =>
  ({ pausedKeys: keys, stopped: "all", paused: true, stops: [stop("paused", ["keys"], keys)] });

/** What the server says of a block on a page held for its credentials. */
const credentialsHeld = (keys: string[] = FINANCIALS_KEYS): Partial<EngineInfo> =>
  ({ stopped: "all", stops: [stop("page_hold", ["auth"], keys)] });

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
    const { engineMode: _mode, engine: _engine, ...rest } = engineBlock(key, { state: "up_to_date", statusReason: null, substreams: [] });
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

type ClassQueue = AgentSyncPageStatus["queue"]["requests"];
type WaitingReason = NonNullable<AgentHistoryRequest["waitingReason"]>;

/** A queue and a reason as the response carries them: a reason is a string on
 *  the wire, whichever ones the contract this file compiles against lists
 *  (`route_budget` and `route_hold` are the hold set's, S4-30). */
const wireQueue = (queue: { runnable: number; waitingByReason: Record<string, number> }) => queue as ClassQueue;
const wireReason = (reason: string) => reason as WaitingReason;

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
    // Its five blocks at a glance, in the tab's words.
    expect(html.match(/data-engine-block=/g)).toHaveLength(5);
    expect(html.match(/читается · последнее чтение \d+ [а-я]+ назад/g)).toHaveLength(5);
    for (const label of ["Подключение", "Финансы", "Аудитория", "Список чатов", "Сообщения чатов"]) expect(html).toContain(label);
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
    expect(html).toContain("владельца нет: страницу никто не читает");
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
    expect(absent).toContain("Подключение");
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

describe("the «Синк» tab: why work waits", () => {
  it("a route's own pace is ready to run; a 429's hold of a route is a wait, in the queue and in a request", () => {
    // The server counts `route_budget` rows in `runnable` and in
    // `waitingByReason` alike: under «Ждёт» they would be shown twice.
    const paced = wireQueue({ runnable: 5, waitingByReason: { route_budget: 4, pacer: 1 } });
    expect(engineWaitingText(paced)).toBe("");
    const held = wireQueue({ runnable: 5, waitingByReason: { route_budget: 4, pacer: 1, route_hold: 2, not_due: 7 } });
    expect(engineWaitingText(held)).toBe("удержание эндпоинта (429): 2, ждёт срока: 7");

    const html = renderRouted(createElement(EngineQueueTable, {
      status: status({ queue: { urgent: paced, requests: held, planned: { runnable: 0, waitingByReason: {} } } }),
    }));
    expect(html).toContain(">удержание эндпоинта (429): 2, ждёт срока: 7<");
    expect(html).not.toContain("пауза эндпоинта");
    expect(html).not.toMatch(/route_(budget|hold)/);

    const request = (waitingReason: string) => plain(renderToStaticMarkup(createElement("ul", null,
      createElement(HistoryRequestCard, {
        request: historyRequest({ waitingReason: wireReason(waitingReason), waitingUntil: "2026-10-02T12:05:00.000Z" }),
        now: NOW_MS,
      }))));
    expect(request("route_hold")).toMatch(/>удержание эндпоинта \(429\) до \d/);
    expect(request("route_budget")).toMatch(/>пауза эндпоинта до \d/);
  });

  // The dictionary is the engine's and closed: a reason the engine gains must
  // get its words here, and the rows it counts as ready to run must not be
  // listed as waiting as well.
  it("names every reason of the engine, and lists as waiting exactly what the engine does not count as ready to run", () => {
    for (const reason of WAITING_REASONS) {
      expect(engineWaitLabel(reason), reason).not.toBe(reason);
      const listed = engineWaitingText(wireQueue({ runnable: 0, waitingByReason: { [reason]: 1 } })) !== "";
      expect(listed, reason).toBe(!isRunnableReason(reason));
    }
  });

  // One dictionary for every surface (S4-34): the «Синк» tab reads it in
  // Russian — its own rows and, since S4-35, its block cards — the analytics
  // Coverage panel in English. A reason the engine gains needs both, in this
  // one table.
  it("holds every reason's words in both languages, and the block cards read a stream's wait from it", () => {
    for (const reason of WAITING_REASONS) {
      const english = engineWaitWords(reason, "en");
      const russian = engineWaitWords(reason, "ru");
      expect(english, reason).not.toBeNull();
      expect(english, reason).not.toMatch(/_/);
      expect(russian, reason).toMatch(/[а-яё]/i);
      expect(engineWaitLabel(reason, "en"), reason).toBe(english);
      // Ready to run is one word in English, whatever it waits its turn behind.
      if (isRunnableReason(reason)) expect(english, reason).toBe("queued");
      // A stream that is read says why its earliest work waits.
      const block = engineBlock("connection");
      const substream = { ...block.substreams[0]!, statusReason: { code: reason, summary: "", waitingFor: null } };
      expect(engineSubstreamStateText(block, substream), reason).toBe(russian!.charAt(0).toUpperCase() + russian!.slice(1));
    }
    expect(engineWaitWords("engine_quarantined", "en")).toBeNull();
    expect(engineWaitLabel("a_reason_of_tomorrow", "en")).toBe("a_reason_of_tomorrow");
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
    expect(html).toContain("готово 1 из 1 фана");
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
  it("shows the status with the hour's requests by resource, every open request and the last ones that ended", () => {
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
    expect(html).toContain("Последние закрытые");
    expect(html.match(/data-history-request=/g)).toHaveLength(2);
    expect(queries.useSyncHistoryRequests).toHaveBeenCalledWith({ pageLabel: "lilly-1", state: "open", limit: 200 }, { enabled: true });
    expect(queries.useSyncHistoryRequests).toHaveBeenCalledWith({ pageLabel: "lilly-1", limit: 20 }, { enabled: true });
  });

  it("keeps the five blocks, their streams in the tab's words and the buttons that act on the engine", () => {
    const html = renderRouted(createElement(EnginePageDetail, { pageLabel: "lilly-1", onBack: vi.fn() }));
    for (const label of ["Подключение", "Финансы", "Аудитория", "Список чатов", "Сообщения чатов"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Ждёт срока");
    expect(html).toContain("Пауза владельца");
    expect(html).toContain("Опросить сейчас");
    // One language inside the tab: nothing of a block is said in English.
    for (const english of ["Sync Now", "Pause", "Resume", "Requeue", "Last success", "Next due", "Substreams", "Sync Engine"]) {
      expect(html, english).not.toContain(english);
    }
  });

  it("a stream the engine reads on a trigger, not on a poll, shows no interval", () => {
    const blocks = page();
    const reconcile = { ...blocks.blocks.audience.substreams[1]!, stream: "followers_reconcile" as const, cadenceSeconds: 0 };
    blocks.blocks.audience = engineBlock("audience", { substreams: [blocks.blocks.audience.substreams[0]!, reconcile] });
    queries.usePageSyncBlocks.mockReturnValue(loaded({ generatedAt: NOW, page: blocks }));
    const html = renderRouted(createElement(EnginePageDetail, { pageLabel: "lilly-1", onBack: vi.fn() }));
    expect(html).toContain("сверка фолловеров");
    expect(html).toContain("раз в 5 мин");
    expect(html).not.toContain("раз в 0");
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
      connectionStatus: null,
      substreams: [],
    });
    const withoutEngine = (block: SyncBlockStatus): SyncBlockStatus => {
      const { engineMode: _mode, engine: _engine, ...rest } = block;
      return rest;
    };
    const blocks = {
      connection: withoutEngine(unserved("connection")),
      financials: withoutEngine(unserved("financials")),
      audience: withoutEngine(unserved("audience")),
      messages_live: withoutEngine(unserved("messages_live")),
      messages_history: withoutEngine(unserved("messages_history")),
    };
    queries.usePageSyncBlocks.mockReturnValue(loaded({ generatedAt: NOW, page: { ...page(), blocks } }));
    queries.useSyncEnginePages.mockReturnValue(loaded({ pages: [] }));
    const html = renderRouted(createElement(EnginePageDetail, { pageLabel: "lilly-1", onBack: vi.fn() }));
    expect(html.match(/Fansly Sync Engine не ведёт эту страницу: блок никто не читает\./g)).toHaveLength(5);
    expect(html).toContain("Fansly Sync Engine не читает эту страницу");
    expect(html).not.toContain("The Fansly Sync Engine does not run this page");
    expect(html).not.toContain("Опросить сейчас");
    expect(html).not.toContain("Пауза");
    expect(isEngineBlock(blocks.financials)).toBe(false);
    // On the page's card of the list each block reads as not read.
    expect(plain(renderToStaticMarkup(createElement(EngineBlockRow, { block: blocks.financials })))).toContain("не читается");
    // «Синхронизация» would say the same of such a block.
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
    // The page's own tab says it in its own words, from what holds the page.
    const held = page();
    held.blocks.connection = engineBlock("connection", { needsAttention: true }, credentialsHeld(["account.poll"]));
    queries.useSyncOverview.mockReturnValue(loaded({ generatedAt: NOW, diagnosis, pages: [{ ...held, diagnosis }, legacyPage()] }));
    const engine = renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }));
    expect(engine).toContain("Удержание страницы: Fansly не принимает данные входа — до новых данных входа");
    expect(engine).toContain('href="/settings?tab=credentials"');
    expect(engine).not.toContain("Reconnect credentials");
  });

  it("a Fansly page opened here points to «Синк»", () => {
    const html = renderRouted(createElement(SyncPageDetail, { pageLabel: "lilly-1", onBack: vi.fn() }));
    expect(html).toContain("Страницу lilly-1 читает Fansly Sync Engine");
    expect(html).toContain('href="/settings?tab=engine&amp;page=lilly-1"');
    expect(html).not.toContain("Financials");
    expect(html).not.toContain("Sync Now");
  });
});

// S4-35: what is on screen must be true about whether a page is sending or
// held. The blocks of a Fansly page say it from the server's verdict over the
// block's own keys, and their buttons act on those keys and say what they did.
describe("the engine's blocks say what is true of them", () => {
  const row = (block: SyncBlockStatus) => plain(renderToStaticMarkup(createElement(EngineBlockRow, { block, now: NOW_MS })));
  const cardOf = (block: SyncBlockStatus) =>
    renderRouted(createElement(EngineBlockCard, { block, pageLabel: "lilly-1", now: NOW_MS }));
  const stateOf = (html: string) => html.match(/data-engine-state="([a-z_]+)"/)?.[1];
  /** The "Следующее" line of a card's timing (its streams' table has a column of that name). */
  const NEXT_LINE = '<span class="text-text-muted">Следующее</span>';

  it("a block that is read says so, with its last read, its next and its polls", () => {
    const block = engineBlock("financials");
    expect(engineBlockState(block)).toBe("reading");
    expect(engineBlockSummary(block, NOW_MS)).toBe("читается · последнее чтение 2 мин назад");
    const html = cardOf(block);
    expect(stateOf(html)).toBe("reading");
    expect(html).toContain("</span>Читается</span>");
    expect(html).toContain(`${NEXT_LINE}<span class="text-text-secondary">через 3 мин</span>`);
    expect(html).toContain("транзакции — раз в 5 мин");
    expect(html).not.toContain("data-engine-stops");
    expect(row(block)).toContain("bg-green");
  });

  it("a paused block says it is paused, not when it is next due", () => {
    const pausedStream = (substream: SyncBlockStatus["substreams"][number], keys: string[]) => ({
      ...substream,
      engine: { stopped: "all" as const, paused: true, activeWork: 1, stops: [stop("paused", ["keys"], keys)] },
    });
    const [transactions, topSpenders] = engineBlock("financials").substreams;
    const block = engineBlock("financials", {
      substreams: [
        pausedStream(transactions!, FINANCIALS_KEYS.slice(0, 4)),
        pausedStream(topSpenders!, FINANCIALS_KEYS.slice(4)),
      ],
    }, allPaused());
    expect(engineBlockState(block)).toBe("paused");
    expect(engineBlockSummary(block, NOW_MS)).toBe("пауза владельца · последнее чтение 2 мин назад");
    const html = cardOf(block);
    expect(stateOf(html)).toBe("paused");
    expect(html).toContain("</span>Пауза владельца</span>");
    expect(html).toMatch(/data-engine-stops[^>]*><p[^>]*>Пауза владельца<\/p>/);
    expect(html).not.toContain(NEXT_LINE);
    // The owner's own pause is said, not sounded as a failure.
    expect(html).not.toContain("text-warning-dark");
    // Its streams have nothing due either, whatever their rows' due times are:
    // each says the pause (in the table and in the phone's list).
    expect(html).not.toContain("через 3 мин");
    expect(html.match(/<span class="text-text-secondary">Пауза владельца<\/span>/g)).toHaveLength(4);
    // The whole page paused: the block says which pause it is.
    const whole = engineBlock("financials", {}, {
      pausedAll: true, stopped: "all", paused: true, stops: [stop("paused", ["page"], FINANCIALS_KEYS)],
    });
    expect(engineBlockSummary(whole, NOW_MS)).toBe("пауза владельца: вся страница · последнее чтение 2 мин назад");
  });

  it("a block whose route a 429 holds says so with the hold's end, on the list and in detail", () => {
    const keys = ["dm-messages.head", "dm-messages.catchup", "dm-messages.history"];
    const block = engineBlock("messages_history", { nextDueAt: null, intervals: [], substreams: [] }, {
      keys, pollKeys: [], stopped: "all", stops: [stop("route_hold", ["messages.page"], keys, "2026-10-02T12:05:00.000Z")],
    });
    expect(engineBlockState(block)).toBe("held");
    expect(engineBlockSummary(block, NOW_MS))
      .toMatch(/^удержание эндпоинта messages\.page \(429\) до \d[\d:]* · последнее чтение 2 мин назад$/);
    expect(row(block)).toMatch(/text-warning-dark">удержание эндпоинта messages\.page \(429\) до \d/);
    const html = cardOf(block);
    expect(stateOf(html)).toBe("held");
    expect(html).toContain("</span>Удержано</span>");
    expect(html).toMatch(/Удержание эндпоинта messages\.page \(429\) до \d[\d:]*<\/p>/);
    // Nothing of it is due while the hold stands, and it has no poll a "sync now" could move.
    expect(html).not.toContain(NEXT_LINE);
    expect(html).not.toContain("Опросить сейчас");
    expect(engineBlockButtons(block)).toEqual({ trigger: false, pause: { label: "Пауза" }, resume: null, requeue: null });
  });

  it("a breaker of one file holds a part of a block: the keys it stops are named, and the stream says so", () => {
    const held = stop("resource_hold", ["followers"], ["followers.head", "followers.reconcile"], "2026-10-02T15:00:00.000Z");
    const followers = {
      ...engineBlock("audience").substreams[0]!,
      stream: "followers" as const,
      statusReason: { code: "resource_hold", summary: "followers.head: resource_hold", waitingFor: null },
      engine: { stopped: "some" as const, stops: [{ ...held, resources: ["followers.head"] }], paused: false, activeWork: 2 },
    };
    const subscribers = { ...engineBlock("audience").substreams[0]!, stream: "subscribers" as const };
    const block = engineBlock("audience", { substreams: [subscribers, followers] }, {
      keys: ["subscribers.poll", "subscribers.history", "followers.head", "followers.reconcile", "fan-profiles.lookup"],
      stopped: "some",
      stops: [held],
    });
    expect(engineBlockState(block)).toBe("partly_held");
    expect(engineBlockSummary(block, NOW_MS))
      .toMatch(/^частично удержано: удержание ресурса followers после ошибок до \d[\d:]* · последнее чтение 2 мин назад$/);
    const html = cardOf(block);
    expect(html).toMatch(/Удержание ресурса followers после ошибок до \d[\d:]*: followers\.head, followers\.reconcile<\/p>/);
    expect(engineSubstreamStateText(block, followers)).toBe("Частично удержано");
    expect(engineSubstreamStateText(block, subscribers)).toBe("Ждёт срока");
    // What of the block is read still has a next read.
    expect(html).toContain(NEXT_LINE);
  });

  // Seen in review: the reconcile walk's row under a green dot reading
  // «Удержание эндпоинта (429)». A stream whose work a route's hold put off
  // comes from the server stopped: its row says held, in the warning tone.
  it("a stream whose work a route's hold put off says it is held, not its wait under a green dot", () => {
    const until = "2026-10-02T12:05:00.000Z";
    const hold = stop("route_hold", ["followers.page"], ["followers.head", "followers.reconcile"], until);
    const base = engineBlock("audience").substreams[0]!;
    const reconcile = {
      ...base,
      stream: "followers_reconcile" as const,
      nextDueAt: null,
      statusReason: { code: "route_hold", summary: `followers.reconcile: route_hold until ${until}`, waitingFor: null },
      engine: { stopped: "some" as const, stops: [{ ...hold, resources: ["followers.reconcile"] }], paused: false, activeWork: 1 },
    };
    const subscribers = { ...base, stream: "subscribers" as const };
    const block = engineBlock("audience", { substreams: [subscribers, reconcile] }, {
      keys: ["subscribers.poll", "subscribers.history", "followers.head", "followers.reconcile", "fan-profiles.lookup"],
      stopped: "some",
      stops: [hold],
    });
    expect(engineSubstreamStateText(block, reconcile)).toBe("Частично удержано");
    const html = cardOf(block);
    const table = html.slice(html.indexOf('data-engine-streams="table"'), html.indexOf('data-engine-streams="list"'));
    const walk = table.slice(table.indexOf('data-engine-stream="followers_reconcile"'));
    expect(walk).toMatch(/^[^>]*>.*?<span class="[^"]*bg-warning-dark"><\/span><span class="text-warning-dark">Частично удержано<\/span>/);
    // The stream that is read keeps its green dot and its wait.
    const read = table.slice(table.indexOf('data-engine-stream="subscribers"'), table.indexOf('data-engine-stream="followers_reconcile"'));
    expect(read).toMatch(/bg-green"><\/span><span class="text-text-secondary">Ждёт срока<\/span>/);
    expect(html).not.toContain(">Удержание эндпоинта (429)<");
    // The block's line names both keys the hold stops.
    expect(html).toMatch(/Удержание эндпоинта followers\.page \(429\) до \d[\d:]*: followers\.head, followers\.reconcile<\/p>/);
  });

  it("a block's streams are a table where its columns fit and one labelled block per stream where they would not", () => {
    const html = cardOf(engineBlock("financials"));
    expect(html).toContain('class="@container ');
    const table = html.slice(html.indexOf('data-engine-streams="table"'), html.indexOf('data-engine-streams="list"'));
    const list = html.slice(html.indexOf('data-engine-streams="list"'));
    // One of the two shows at any width of the card.
    expect(html).toMatch(/<table class="hidden [^"]*@md:table[^"]*" data-engine-streams="table"/);
    expect(html).toMatch(/<ul class="[^"]*@md:hidden[^"]*" data-engine-streams="list"/);
    for (const part of [table, list]) {
      for (const cell of ["транзакции", "Ждёт срока", "2 мин назад", "через 3 мин", "раз в 5 мин", "топ-спендеры", "Пауза владельца", "раз в 6 ч"]) {
        expect(part, cell).toContain(`>${cell}<`);
      }
    }
    // The list labels each value; the table has them as its columns.
    for (const label of ["Последнее чтение", "Следующее", "Опрос"]) {
      expect(list).toContain(`<dt class="text-text-muted">${label}</dt>`);
      expect(table).toContain(`>${label}</th>`);
    }
    // A block of one stream has neither.
    const single = cardOf(engineBlock("connection", { substreams: [engineBlock("connection").substreams[0]!] }));
    expect(single).not.toContain("data-engine-streams");
  });

  it("a page held for its credentials: every block says the page is held, and the connection block points to the credentials form", () => {
    const refused = engineBlock("connection", { needsAttention: true }, {
      keys: ["account.poll"], pollKeys: ["account.poll"], ...credentialsHeld(["account.poll"]),
    });
    expect(engineBlockState(refused)).toBe("page_held");
    // The hold is named once, on the page: its blocks' lines stay short.
    expect(engineBlockSummary(refused, NOW_MS)).toBe("страница удержана · последнее чтение 2 мин назад");
    // No requeue: nothing is quarantined, and new credentials are what ends the hold.
    expect(engineBlockButtons(refused).requeue).toBeNull();
    const html = cardOf(refused);
    expect(html).toContain("Удержание страницы: Fansly не принимает данные входа — до новых данных входа");
    expect(html).toContain('href="/settings?tab=credentials"');
    expect(html).toContain("Обновить данные входа");
    expect(html).not.toContain("карантин");
    const financials = cardOf(engineBlock("financials", {}, credentialsHeld()));
    expect(stateOf(financials)).toBe("page_held");
    expect(financials).not.toContain("tab=credentials");
    expect(financials).not.toContain(NEXT_LINE);
  });

  it("the requeue is offered only for quarantined work and names what it takes", () => {
    // Work Fansly refuses needs the owner, and a requeue would not touch it.
    const blocked = engineBlock("financials", { needsAttention: true }, {
      blockedByVendor: { count: 1, resources: ["transactions.rescan"] },
    });
    expect(engineBlockButtons(blocked).requeue).toBeNull();
    expect(cardOf(blocked)).toContain(
      "Fansly отказывает: transactions.rescan · pnpm cli sync work list --page lilly-1 --state open --resource transactions.rescan",
    );
    expect(cardOf(blocked)).not.toContain("Вернуть из карантина");

    const quarantined = engineBlock("financials", { needsAttention: true }, {
      quarantined: { count: 2, resources: ["transactions.head", "transactions.rescan"] },
    });
    expect(engineBlockState(quarantined)).toBe("attention");
    expect(engineBlockSummary(quarantined, NOW_MS)).toBe("нужно внимание · в карантине 2 · последнее чтение 2 мин назад");
    expect(engineBlockButtons(quarantined).requeue).toEqual({ label: "Вернуть из карантина (2)" });
    expect(engineRequeueConfirmText(quarantined, "lilly-1")).toBe(
      "2 строки в карантине (transactions.head, transactions.rescan) на lilly-1 запустятся снова: "
      + "сохранённый ответ применяется из журнала без нового запроса. Ничего не удаляется.",
    );
    const html = cardOf(quarantined);
    expect(html).toContain(
      "В карантине: 2 (transactions.head, transactions.rescan) · pnpm cli sync work list --page lilly-1 --state quarantined",
    );
    expect(html).toContain("Вернуть из карантина (2)");
    // A page in handover reads nothing: no lever that would.
    const handover = engineBlock("financials", { engineMode: "handover", needsAttention: true }, {
      mode: "handover", ownerRunning: false, quarantined: { count: 1, resources: ["transactions.rescan"] },
    });
    expect(engineBlockButtons(handover)).toMatchObject({ trigger: false, requeue: null });
    expect(engineBlockSummary(handover, NOW_MS)).toBe("не читается: переключение");
  });

  it("pause and resume act on the block's own keys, and a partial pause is shown as partial", () => {
    expect(engineBlockButtons(engineBlock("financials"))).toEqual({
      trigger: true, pause: { label: "Пауза" }, resume: null, requeue: null,
    });
    // Every key paused: nothing left to pause, and no poll a "sync now" would be read for.
    expect(engineBlockButtons(engineBlock("financials", {}, allPaused()))).toEqual({
      trigger: false, pause: null, resume: { label: "Снять паузу" }, requeue: null,
    });
    const some = ["transactions.head", "top-spenders.window"];
    const partly = engineBlock("financials", {}, { pausedKeys: some, stopped: "some", stops: [stop("paused", ["keys"], some)] });
    expect(engineBlockState(partly)).toBe("partly_paused");
    expect(engineBlockButtons(partly)).toEqual({
      trigger: true,
      pause: { label: "Пауза для остальных (4)" },
      resume: { label: "Снять паузу (2 из 6)" },
      requeue: null,
    });
    const html = cardOf(partly);
    expect(html).toContain("</span>Частично на паузе</span>");
    expect(html).toContain("Пауза владельца: transactions.head, top-spenders.window");
    expect(html).toContain("Пауза для остальных (4)");
    expect(html).toContain("Снять паузу (2 из 6)");
    // The whole page paused by the owner: the block's polls would be read by nobody.
    const whole = engineBlock("financials", {}, {
      pausedAll: true, stopped: "all", paused: true, stops: [stop("paused", ["page"], FINANCIALS_KEYS)],
    });
    expect(engineBlockButtons(whole).trigger).toBe(false);
  });

  it("a lever's notice says what it moved — never 'done' for nothing — and when nothing will be sent anyway", () => {
    const answer = (affected: number) => ({ engine: { mode: "live" as const, resources: [], affected } });
    const block = engineBlock("financials");
    // Sync now.
    expect(engineLeverNotice("trigger", block, answer(3), NOW_MS)).toEqual({
      kind: "success", text: "Финансы: 3 опроса поставлены в очередь",
    });
    expect(engineLeverNotice("trigger", block, answer(1), NOW_MS).text).toBe("Финансы: 1 опрос поставлен в очередь");
    expect(engineLeverNotice("trigger", block, answer(0), NOW_MS)).toEqual({
      kind: "message", text: "Финансы: ни один опрос не сдвинут — опросы блока уже в очереди или выполняются",
    });
    const held = engineBlock("financials", {}, credentialsHeld());
    expect(engineLeverNotice("trigger", held, answer(3), NOW_MS)).toEqual({
      kind: "warning",
      text: "Финансы: 3 опроса поставлены в очередь; запросы не уйдут — "
        + "удержание страницы: Fansly не принимает данные входа — до новых данных входа",
    });
    expect(engineLeverNotice("trigger", held, answer(0), NOW_MS)).toMatchObject({ kind: "warning" });
    const orphan = engineBlock("financials", {}, { ownerRunning: false });
    expect(engineLeverNotice("trigger", orphan, answer(2), NOW_MS)).toEqual({
      kind: "warning", text: "Финансы: 2 опроса поставлены в очередь; запросы не уйдут — страницу не ведёт ни один sync-хост",
    });
    // A hold of a part of the block leaves something to send: no warning.
    const partlyHeld = engineBlock("financials", {}, {
      stopped: "some", stops: [stop("resource_hold", ["transactions"], ["transactions.head"], "2026-10-02T15:00:00.000Z")],
    });
    expect(engineLeverNotice("trigger", partlyHeld, answer(2), NOW_MS).kind).toBe("success");
    // Pause and resume.
    expect(engineLeverNotice("pause", block, answer(6), NOW_MS)).toEqual({ kind: "success", text: "Финансы: на паузе 6 ключей" });
    expect(engineLeverNotice("pause", block, answer(0), NOW_MS)).toEqual({ kind: "message", text: "Финансы: ключи блока уже на паузе" });
    const paused = engineBlock("financials", {}, allPaused());
    expect(engineLeverNotice("resume", paused, answer(6), NOW_MS)).toEqual({ kind: "success", text: "Финансы: пауза снята с 6 ключей" });
    expect(engineLeverNotice("resume", paused, answer(1), NOW_MS).text).toBe("Финансы: пауза снята с 1 ключа");
    expect(engineLeverNotice("resume", block, answer(0), NOW_MS)).toEqual({ kind: "message", text: "Финансы: на паузе ничего не было" });
    // The pause lifted, the page still held for its credentials: said.
    const pausedAndHeld = engineBlock("financials", {}, {
      ...allPaused(), stops: [stop("paused", ["keys"], FINANCIALS_KEYS), stop("page_hold", ["auth"], FINANCIALS_KEYS)],
    });
    expect(engineLeverNotice("resume", pausedAndHeld, answer(6), NOW_MS)).toEqual({
      kind: "warning",
      text: "Финансы: пауза снята с 6 ключей; запросы не уйдут — "
        + "удержание страницы: Fansly не принимает данные входа — до новых данных входа",
    });
    // The requeue.
    expect(engineLeverNotice("reset", block, answer(0), NOW_MS)).toEqual({
      kind: "message", text: "Финансы: в карантине ничего не было — возвращать нечего",
    });
    expect(engineLeverNotice("reset", block, answer(1), NOW_MS)).toEqual({ kind: "success", text: "Финансы: из карантина возвращена 1 строка" });
    expect(engineLeverNotice("reset", block, answer(5), NOW_MS).text).toBe("Финансы: из карантина возвращено 5 строк");
    // An answer without the engine's part (a server of another build) moved nothing it can vouch for.
    expect(engineLeverNotice("pause", block, {}, NOW_MS).kind).toBe("message");
  });

  it("a page nobody runs does not look live: the chip, the owner and every block say so", () => {
    const chip = (mode: AgentSyncPageStatus["mode"], ownerRunning: boolean) =>
      renderToStaticMarkup(createElement(EngineModeChip, { mode, ownerRunning }));
    expect(chip("live", true)).toContain("text-green");
    expect(chip("live", true)).toContain(">live<");
    const orphanChip = chip("live", false);
    expect(orphanChip).toContain(">live · нет владельца<");
    expect(orphanChip).not.toContain("green");
    expect(orphanChip).toContain("text-warning-dark");
    expect(chip("handover", false)).toContain(">переключение<");

    const silent = status({
      owner: { generation: "4", host: "sync-1", acquiredAt: NOW, heartbeatAt: "2026-10-02T11:00:00.000Z", running: false },
    });
    expect(engineOwnerText(silent, NOW_MS)).toBe("владельца нет: страницу никто не читает (последний ответ 60 мин назад)");
    expect(renderRouted(createElement(EngineStatusGrid, { status: silent, pageLabel: "lilly-1", now: NOW_MS })))
      .toContain('<span class="text-warning-dark font-medium">владельца нет: страницу никто не читает');
    expect(renderRouted(createElement(EngineStatusGrid, { status: status(), pageLabel: "lilly-1", now: NOW_MS })))
      .toContain('<span class="text-text-secondary">владелец отвечал');

    const orphan = engineBlock("financials", {}, { ownerRunning: false });
    expect(engineBlockState(orphan)).toBe("no_owner");
    expect(engineBlockSummary(orphan, NOW_MS)).toBe("не читается: нет владельца");
    const html = cardOf(orphan);
    expect(stateOf(html)).toBe("no_owner");
    expect(html).toContain("Страницу не ведёт ни один sync-хост: из неё ничего не читается.");
    expect(html).not.toContain(NEXT_LINE);

    queries.useSyncEnginePages.mockReturnValue(loaded({ pages: [silent] }));
    const list = renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }));
    expect(list).toContain('data-engine-running="false"');
    expect(list).toContain("live · нет владельца");
    queries.useSyncEnginePages.mockReturnValue(loaded({ pages: [status()] }));
    expect(renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }))).toContain('data-engine-running="true"');
  });

  it("the page's notice asks for credentials first, else lists the work that needs the owner with its commands", () => {
    const notice = (blocks: Partial<SyncBlocksPage["blocks"]>) => renderRouted(createElement(EnginePageAttention, {
      page: { ...page(), blocks: { ...page().blocks, ...blocks } }, now: NOW_MS,
    }));
    expect(notice({})).toBe("");
    const quarantined = engineBlock("financials", { needsAttention: true }, {
      quarantined: { count: 1, resources: ["transactions.rescan"] },
      blockedByVendor: { count: 2, resources: ["top-spenders.window"] },
    });
    const work = notice({ financials: quarantined });
    expect(work).toContain('data-engine-attention="work"');
    expect(work).toContain("Финансы — В карантине: 1 (transactions.rescan) · pnpm cli sync work list --page lilly-1 --state quarantined");
    expect(work).toContain(
      "Финансы — Fansly отказывает: top-spenders.window · pnpm cli sync work list --page lilly-1 --state open --resource top-spenders.window",
    );
    const refused = notice({
      financials: quarantined,
      connection: engineBlock("connection", { needsAttention: true }, credentialsHeld(["account.poll"])),
    });
    expect(refused).toContain('data-engine-attention="credentials"');
    expect(refused).toContain("Удержание страницы: Fansly не принимает данные входа — до новых данных входа");
    expect(refused).toContain("Из страницы ничего не читается.");
    expect(refused).toContain('href="/settings?tab=credentials"');
    // The page's card of the list carries it.
    queries.useSyncOverview.mockReturnValue(loaded({ generatedAt: NOW, diagnosis: null, pages: [page({}, quarantined)] }));
    expect(renderRouted(createElement(EnginePageList, { onSelectPage: vi.fn() }))).toContain("В карантине: 1 (transactions.rescan)");
  });

  it("«готово N из M фанов» follows the count", () => {
    const fans = (total: number) => historyFansText(historyRequest({
      counts: { total, ready: 0, queued: 0, loading: 0, blocked: 0, refused: 0, cancelled: 0 },
    }));
    expect(fans(1)).toBe("готово 0 из 1 фана");
    expect(fans(5)).toBe("готово 0 из 5 фанов");
    expect(fans(21)).toBe("готово 0 из 21 фана");
    expect(fans(11)).toBe("готово 0 из 11 фанов");
  });
});

describe("the tab's words", () => {
  it("ages, spans and the socket in the owner's words", () => {
    expect(engineAgeText("2026-10-02T11:59:48.000Z", NOW_MS)).toBe("12 с");
    expect(engineAgeText("2026-10-02T11:50:00.000Z", NOW_MS)).toBe("10 мин");
    expect(engineAgeText("2026-10-02T06:00:00.000Z", NOW_MS)).toBe("6 ч");
    expect(engineAgeText("2026-09-30T13:00:00.000Z", NOW_MS)).toBe("47 ч");
    expect(engineAgeText("2026-09-27T12:00:00.000Z", NOW_MS)).toBe("5 сут");
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

// The proof of S4-35, pinned. The engine's blocks have their own cards on
// «Синк»; what the cards «Синхронизация» keeps knew of the engine is gone, and
// a block's keys travel in its typed `engine` part, not in its metrics:
//   rg -n "<each name of GONE below>" apps packages tests                                                                        (no hits)
//   rg -n "sync/(SyncBlock|syncBlockDisplay|SyncPageAttention|SyncDiagnosisNotice)" apps/dashboard/src/pages/settings/engine                                                          (no hits)
//   rg -n 'state === "engine"|engineMode|engine/engineDisplay' apps/dashboard/src/pages/settings/sync                                                                                   (no hits)
describe("the engine's blocks are the «Синк» tab's own (the deletion's proof, step 4 S4-35)", () => {
  const ROOT = path.resolve(".");
  const SKIP = new Set(["node_modules", "dist", ".vite", "client-sdks"]);
  const sources = (target: string): string[] => {
    const full = path.resolve(ROOT, target);
    return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : sources(path.join(target, entry.name));
      return /\.(ts|tsx|json)$/.test(entry.name) ? [path.join(full, entry.name)] : [];
    });
  };
  const hits = (files: readonly string[], pattern: RegExp): string[] => files.flatMap((file) =>
    readFileSync(file, "utf8").split("\n")
      .map((line, index) => ({ line, at: `${path.relative(ROOT, file)}:${index + 1}` }))
      .filter(({ line }) => pattern.test(line))
      .map(({ line, at }) => `${at}: ${line.trim()}`));

  // Spelled in halves so this file is no hit itself.
  const GONE = [
    ["getEngine", "BlockKeys"],
    ["getEngineBlock", "ActionPresentation"],
    ["formatEngine", "BlockSummary"],
    ["engineReason", "Label"],
    ["ENGINE_ATTENTION", "_TONE"],
    ["ENGINE_STATUS", "_LABELS"],
    ["isEngine", "Attention"],
    ["engine", "Keys"],
  ].map(([head, tail]) => `${head}${tail}`);

  it("nothing in apps, packages or tests names what the shared cards knew of the engine", () => {
    const files = ["apps", "packages", "tests"].flatMap(sources);
    expect(files.length).toBeGreaterThan(500);
    expect(hits(files, new RegExp(GONE.join("|")))).toEqual([]);
  });

  it("the «Синк» tab uses none of the legacy block cards, and those cards know nothing of the engine", () => {
    const engine = sources("apps/dashboard/src/pages/settings/engine");
    expect(engine.length).toBeGreaterThan(8);
    expect(hits(engine, /sync\/(SyncBlock|syncBlockDisplay|SyncPageAttention|SyncDiagnosisNotice)/)).toEqual([]);
    const legacy = sources("apps/dashboard/src/pages/settings/sync");
    expect(legacy.length).toBeGreaterThan(8);
    expect(hits(legacy, /state === "engine"|engineMode|engine\/engineDisplay/)).toEqual([]);
  });
});
