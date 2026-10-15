import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatBlockSummary,
  formatBlockProgressCaption,
  formatSubstreamStateLabel,
  getBlockStateLabel,
  getBlockProgressFillClass,
  getBlockTone,
  getDependencyWaitDetail,
  getSubstreamTone,
  needsVisualAttention,
  shouldShowBlockProgressBar,
  syncPageStatus,
  syncResetConfirmText,
} from "../apps/dashboard/src/pages/settings/sync/syncBlockDisplay.ts";

describe("sync block display", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the backend's block-specific metric keys in summaries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));

    expect(formatBlockSummary({
      block: "financials",
      state: "up_to_date",
      succeededAt: "2026-03-24T11:00:00.000Z",
      progress: null,
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { transactionCount: 12 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe("Обновлено 1 ч назад · 12 операций");

    expect(formatBlockSummary({
      block: "audience",
      state: "up_to_date",
      succeededAt: "2026-03-24T11:30:00.000Z",
      progress: null,
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      // A legacy audience block is OnlyFans's: its count is subscribers.
      metrics: { subscriberCount: 5 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe("Обновлено 30 мин назад · 5 подписчиков");

    expect(formatBlockSummary({
      block: "messages_live",
      state: "up_to_date",
      succeededAt: "2026-03-24T10:00:00.000Z",
      progress: null,
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { visibleConversationCount: 4 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe("Обновлено 2 ч назад · 4 чата");
  });

  it("renders stalled blocks with the point they got stuck at", () => {
    expect(formatBlockSummary({
      block: "audience",
      state: "failed",
      succeededAt: "2026-03-18T10:00:00.000Z",
      progress: {
        label: "1 of 697 subscribers processed",
        current: 1,
        total: 697,
        unit: "subscribers",
        percent: 0.14347202295552366,
        details: {},
      },
      error: {
        stream: "subscribers",
        code: "progress_stalled",
        summary: "Sync stopped making progress",
        failedAt: null,
        consecutiveFailures: 0,
      },
      needsAttention: true,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { subscriberCount: 1 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe("Загрузка остановилась на 1 из 697 подписчиков");
  });

  it("renders backfilling blocks without the active syncing copy", () => {
    expect(formatBlockSummary({
      block: "audience",
      state: "backfilling",
      succeededAt: "2026-03-18T10:00:00.000Z",
      progress: {
        label: "1 of 697 subscribers processed",
        current: 1,
        total: 697,
        unit: "subscribers",
        percent: 0.14347202295552366,
        details: {},
      },
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { subscriberCount: 1 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe("Догружает историю… 1 из 697 подписчиков");
  });

  it("describes supporting financial enrichment separately from current transactions", () => {
    expect(formatBlockSummary({
      block: "financials",
      state: "backfilling",
      succeededAt: "2026-03-24T11:59:00.000Z",
      progress: {
        label: "14 / 15 months",
        current: 14,
        total: 15,
        unit: "months",
        percent: 93.33,
        details: {},
      },
      progressStream: "top_spenders",
      progressRole: "supporting",
      error: null,
      statusReason: null,
      primaryFresh: true,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { transactionCount: 120 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe("Операции актуальны; рейтинг топ фанов догружается");
  });

  it("hides completed progress bars once a block is up to date", () => {
    expect(shouldShowBlockProgressBar({
      block: "financials",
      state: "up_to_date",
      succeededAt: "2026-03-24T11:55:00.000Z",
      progress: {
        label: "15 / 15 months",
        current: 15,
        total: 15,
        unit: "months",
        percent: 100,
        details: {},
      },
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { transactionCount: 2879 },
      connectionStatus: null,
      substreams: [],
    } as never)).toBe(false);
  });

  it("replaces 100% messages live progress with finalizing copy", () => {
    const block = {
      block: "messages_live",
      state: "syncing",
      succeededAt: "2026-03-24T11:50:00.000Z",
      progress: {
        label: "27 / 27 conversations",
        current: 27,
        total: 27,
        unit: "conversations",
        percent: 100,
        details: {},
      },
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { visibleConversationCount: 27 },
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(formatBlockSummary(block)).toBe("Завершает обновление списка чатов…");
    expect(shouldShowBlockProgressBar(block)).toBe(false);
  });

  it("shows numeric progress for messages live when current is below total", () => {
    const block = {
      block: "messages_live",
      state: "syncing",
      succeededAt: "2026-03-24T11:50:00.000Z",
      progress: {
        label: "200 / 5,000 conversations",
        current: 200,
        total: 5000,
        unit: "conversations",
        percent: 4,
        details: {},
      },
      error: null,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: { visibleConversationCount: 5000 },
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(formatBlockSummary(block)).toBe("Обновляется… 200 из 5\u00a0000 чатов");
    expect(shouldShowBlockProgressBar(block)).toBe(true);
  });

  it("formats dependency waits without showing raw stream ids", () => {
    const block = {
      block: "financials",
      state: "delayed",
      succeededAt: null,
      progress: null,
      error: {
        stream: "top_spenders",
        code: "unmet_dependency",
        summary: "Waiting for transactions",
        failedAt: null,
        consecutiveFailures: 0,
      },
      statusReason: {
        code: "unmet_dependency",
        summary: "Waiting for transactions",
        waitingFor: ["transactions"],
      },
      primaryFresh: false,
      progressStream: null,
      progressRole: null,
      needsAttention: true,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: {},
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(formatBlockSummary(block)).toBe("Ждёт, пока закончится «операции»");
    expect(getDependencyWaitDetail(block)).toBe("операции");
  });

  it("collapses long dependency waits into a generic summary", () => {
    const block = {
      block: "messages_live",
      state: "delayed",
      succeededAt: null,
      progress: null,
      error: {
        stream: "dm_conversations",
        code: "unmet_dependency",
        summary: "Waiting for light, top_spenders, transactions, subscribers, followers",
        failedAt: null,
        consecutiveFailures: 0,
      },
      statusReason: {
        code: "unmet_dependency",
        summary: "Waiting for light, top_spenders, transactions, subscribers, followers",
        waitingFor: ["light", "top_spenders", "transactions", "subscribers", "followers"],
      },
      primaryFresh: false,
      progressStream: null,
      progressRole: null,
      needsAttention: true,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: {},
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(formatBlockSummary(block)).toBe("Ждёт, пока закончатся другие потоки");
    expect(getDependencyWaitDetail(block)).toBe(
      "подключение, топ фанов, операции, подписчики, фолловеры",
    );
    expect(needsVisualAttention(block)).toBe(false);
  });

  it("renders inline human-readable reasons for delayed substreams", () => {
    expect(formatSubstreamStateLabel({
      stream: "transactions",
      role: "primary",
      state: "delayed",
      succeededAt: "2026-03-24T11:55:00.000Z",
      nextDueAt: "2026-03-24T12:55:00.000Z",
      nextRetryAt: null,
      cadenceSeconds: 3600,
      isFresh: true,
      needsAttention: true,
      statusReason: {
        code: "queue_delayed",
        summary: "Queued too long with no active sync making progress.",
        waitingFor: null,
      },
      error: null,
    } as never)).toBe("Отстаёт · очередь стоит");

    expect(formatSubstreamStateLabel({
      stream: "followers_reconcile",
      role: "supporting",
      state: "delayed",
      succeededAt: null,
      nextDueAt: "2026-03-24T12:21:00.000Z",
      nextRetryAt: null,
      cadenceSeconds: 172800,
      isFresh: false,
      needsAttention: true,
      statusReason: {
        code: "unmet_dependency",
        summary: "Waiting for followers",
        waitingFor: ["followers"],
      },
      error: null,
    } as never)).toBe("Ждёт · фолловеры");
  });

  it("describes expected queue waits without warning copy", () => {
    const block = {
      block: "financials",
      state: "scheduled",
      succeededAt: "2026-03-24T11:55:00.000Z",
      progress: {
        label: "15 / 15 months",
        current: 15,
        total: 15,
        unit: "months",
        percent: 100,
        details: {},
      },
      progressStream: "top_spenders",
      progressRole: "supporting",
      error: null,
      statusReason: {
        code: "queue_waiting",
        summary: "Queued - will start after current sync completes.",
        waitingFor: ["dm_messages"],
      },
      primaryFresh: true,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: {},
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(formatBlockSummary(block)).toBe("Актуально · ждёт, пока закончится «сообщения»");
    expect(getBlockStateLabel(block)).toBe("Актуально");
    expect(getBlockTone(block).text).toBe("text-green");
    expect(shouldShowBlockProgressBar(block)).toBe(false);

    const substream = {
      stream: "transactions",
      role: "primary",
      state: "scheduled",
      succeededAt: "2026-03-24T11:55:00.000Z",
      nextDueAt: "2026-03-24T12:55:00.000Z",
      nextRetryAt: null,
      cadenceSeconds: 3600,
      isFresh: true,
      needsAttention: false,
      statusReason: {
        code: "queue_waiting",
        summary: "Queued - will start after current sync completes.",
        waitingFor: ["dm_messages"],
      },
      error: null,
    } as never;

    expect(formatSubstreamStateLabel(substream)).toBe("Актуально · ждёт «сообщения»");
    expect(getSubstreamTone(substream).text).toBe("text-green");
  });

  it("keeps non-fresh queue waits neutral and visible", () => {
    const block = {
      block: "audience",
      state: "scheduled",
      succeededAt: null,
      progress: {
        label: "14 / 15 months",
        current: 14,
        total: 15,
        unit: "months",
        percent: 93.33,
        details: {},
      },
      progressStream: "followers_reconcile",
      progressRole: "supporting",
      error: null,
      statusReason: {
        code: "queue_waiting",
        summary: "Queued - will start after current sync completes.",
        waitingFor: ["dm_messages"],
      },
      primaryFresh: false,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: {},
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(formatBlockSummary(block)).toBe("В очереди — сейчас идёт «сообщения»");
    expect(getBlockStateLabel(block)).toBe("В очереди");
    expect(getBlockTone(block).text).toBe("text-text-secondary");
    expect(shouldShowBlockProgressBar(block)).toBe(true);
  });

  // A delayed legacy block never shows a bar: the one that did was the
  // legacy Fansly message-history backlog, which no page has any more.
  it("hides the progress bar of a delayed block", () => {
    const block = {
      block: "messages_live",
      state: "delayed",
      succeededAt: "2026-03-24T11:55:00.000Z",
      progress: {
        label: "203 / 3,669 conversations",
        current: 203,
        total: 3669,
        unit: "conversations",
        percent: 5.53,
        details: {},
      },
      progressStream: "dm_conversations",
      progressRole: "primary",
      error: null,
      statusReason: { code: "stale", summary: "Last successful sync is older than the freshness target.", waitingFor: null },
      primaryFresh: false,
      needsAttention: true,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: {},
      connectionStatus: null,
      substreams: [],
    } as never;

    expect(shouldShowBlockProgressBar(block)).toBe(false);
    expect(getBlockProgressFillClass(block)).toBe("bg-accent");
    expect(formatBlockProgressCaption(block)).toBe("список чатов · 203 из 3\u00a0669 чатов");
  });

  // The OnlyFans screen opens a page with one status line, in the words the
  // Fansly screen uses where they mean the same.
  it("says what an OnlyFans page is now, in one line", () => {
    const block = (key: string, overrides: Record<string, unknown> = {}) => ({
      block: key, state: "up_to_date", succeededAt: "2026-03-24T11:55:00.000Z", progress: null, progressStream: null,
      progressRole: null, error: null, statusReason: null, primaryFresh: true, needsAttention: false, nextDueAt: null,
      nextRetryAt: null, intervals: [], metrics: {}, connectionStatus: null, substreams: [], ...overrides,
    });
    const page = (overrides: Record<string, Record<string, unknown>> = {}, diagnosis: unknown = null) => ({
      pageId: 1, pageLabel: "lora-of", platform: "onlyfans", modelSlug: "lora", modelName: "Lora", username: "lora",
      displayName: null, diagnosis,
      blocks: Object.fromEntries(["connection", "financials", "audience", "messages_live", "messages_history"]
        .map((key) => [key, block(key, overrides[key])])),
    }) as never;
    expect(syncPageStatus(page())).toMatchObject({ kind: "working", label: "Работает", tone: "success" });
    expect(syncPageStatus(page({ financials: { state: "paused" } })))
      .toMatchObject({ kind: "working", reason: "на паузе: блок «Финансы»" });
    const paused = { state: "paused" };
    expect(syncPageStatus(page({ connection: paused, financials: paused, audience: paused, messages_live: paused, messages_history: paused })))
      .toMatchObject({ kind: "paused", label: "На паузе" });
    expect(syncPageStatus(page({ messages_history: { state: "delayed", needsAttention: true } })))
      .toMatchObject({ kind: "lagging", label: "Отстаёт", reason: "блок «Сообщения»" });
    expect(syncPageStatus(page({ audience: { state: "failed" } }))).toMatchObject({ kind: "failed", label: "Ошибка", tone: "danger" });
    expect(syncPageStatus(page({ connection: {
      state: "failed", needsAttention: true, statusReason: { code: "credentials_invalid", summary: "Session expired", waitingFor: null },
    } }))).toMatchObject({ kind: "login", label: "Нужен вход" });
    expect(syncPageStatus(page({ financials: { state: "syncing" } }))).toMatchObject({ kind: "syncing", label: "Обновляется" });
    const fresh = { state: "not_started", succeededAt: null };
    expect(syncPageStatus(page({ connection: fresh, financials: fresh, audience: fresh, messages_live: fresh, messages_history: fresh })))
      .toMatchObject({ kind: "not_started", label: "Ещё не запускался" });
  });

  it("an honest reset confirmation: what it forgets, and what else of the block goes", () => {
    expect(syncResetConfirmText("audience", "lora-of")).toBe(
      "Hub забудет, докуда загружен блок «Аудитория» страницы lora-of, и загрузит его заново с самого начала. Уже загруженные данные остаются.",
    );
    expect(syncResetConfirmText("financials", "lora-of")).toContain("Рейтинг топ фанов страницы будет собран заново.");
    expect(syncResetConfirmText("messages_history", "lora-of")).toContain("Сейчас сервер отклоняет этот сброс");
  });
});
