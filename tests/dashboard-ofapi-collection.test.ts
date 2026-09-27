vi.mock("../apps/dashboard/src/pages/settings/OfapiContentEvidence.tsx", () => ({ OfapiContentEvidence: () => null }));
vi.mock("../apps/dashboard/src/pages/settings/OfapiStoredReads.tsx", () => ({ OfapiStoredReads: () => null }));
// Adjacent settings panels have their own query/provider lifecycle and acceptance coverage.
vi.mock("../apps/dashboard/src/pages/settings/OfapiWebhookRecovery.tsx", () => ({ OfapiWebhookRecovery: () => null }));
vi.mock("../apps/dashboard/src/pages/settings/OfapiBannedWords.tsx", () => ({ OfapiBannedWords: () => null }));
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Root tests cannot resolve @tanstack/react-query (dashboard-local dep), so the
// api layer is mocked at module level — the same pattern as
// dashboard-configuration-tab.test.ts / dashboard-ofapi-credits.test.ts.
const collectionMocks = vi.hoisted(() => ({
  useAdminOfapiCollection: vi.fn(),
  useAdminOfapiWebhookStatus: vi.fn(),
  useOfapiCollectionPreview: vi.fn(),
  useOfapiCollectionApply: vi.fn(),
  useOfapiCollectionJobCreate: vi.fn(),
  useOfapiCollectionJobResume: vi.fn(() => ({ isPending: false, isError: false, mutate: vi.fn() })),
  useOfapiCollectionJobFinishIncomplete: vi.fn(),
  OFAPI_COLLECTION_QUERY_KEY: ["admin", "ofapi-collection"],
}));

const usersMocks = vi.hoisted(() => ({
  useAdminUsers: vi.fn(),
}));

// OfapiCreditsPage reads its four hooks from the queries barrel.
const creditsQueryMocks = vi.hoisted(() => ({
  useAdminOfapiCreditsSummary: vi.fn(),
  useAdminOfapiCreditsDaily: vi.fn(),
  useAdminOfapiCreditsLedger: vi.fn(),
  useAdminOfapiSpendComparison: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/adminOfapiCollection.ts", () => collectionMocks);
vi.mock("../apps/dashboard/src/api/adminUsers.ts", () => usersMocks);
vi.mock("../apps/dashboard/src/api/queries.ts", () => creditsQueryMocks);

// sdk.ts drags in @/lib/queryClient (→ @tanstack/react-query); the tab only
// needs KernelApiError for the 409 instanceof check.
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({
  KernelApiError: class KernelApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import type {
  OfapiCollectionCatalogEntry,
  OfapiCollectionCategory,
  OfapiCollectionPolicy,
  OfapiCollectionSettings,
  OfapiCollectionSnapshot,
} from "../apps/dashboard/src/api/adminOfapiCollection.ts";
import {
  CategoryEditor,
  CollectionTab,
  ConflictModal,
  DraftBar,
  PauseModal,
  PreviewModal,
  JobsCard,
  FinishIncompleteRunModal,
} from "../apps/dashboard/src/pages/settings/collection/CollectionTab.tsx";
import {
  buildCategoryView,
  buildCategoryViews,
  buildChangeBody,
  describePolicyPill,
  describeSettings,
  diffDraftAgainstSnapshot,
  draftBlockReason,
  draftEnableCount,
  draftKey,
  emptyDraft,
  formatBytes,
  groupCategoryViews,
  groupWebhookEvents,
  intervalLabel,
  localDateTimeToIso,
  maskWebhookId,
  parseAuditChanges,
  parseSelection,
  restoreDraft,
  rowState,
  sameSettings,
  serializeDraft,
  stopSummary,
  summarizeAudit,
  usageTotals,
  type CollectionDraft,
} from "../apps/dashboard/src/pages/settings/collection/collectionModel.ts";
import { buildSettingsRoute, resolveSettingsTab } from "../apps/dashboard/src/lib/navigation.ts";
import { OfapiCreditsPage } from "../apps/dashboard/src/pages/OfapiCreditsPage.tsx";

// ---------------------------------------------------------------------------
// Fixtures — mirror packages/shared/src/ofapi-collection-registry.ts and the
// snapshot shape of routes-ofapi-collection.ts.

const CATEGORY_IDS: OfapiCollectionCategory[] = [
  "core_messages", "core_payments", "core_audience", "posts_comments", "visitors",
  "tracking_links", "smart_links", "vault_catalog", "vault_files", "balances",
  "profile_notifications", "content_history", "media_previews",
];

const SERVER_LABELS: Record<OfapiCollectionCategory, string> = {
  core_messages: "Messages",
  core_payments: "Payments",
  core_audience: "Audience",
  posts_comments: "Posts and comments",
  visitors: "Profile visitors",
  tracking_links: "Tracking links",
  smart_links: "Smart links",
  vault_catalog: "Vault catalog",
  vault_files: "Owned media uploads",
  balances: "Balances and payouts",
  profile_notifications: "Profile and notifications",
  content_history: "Stories, highlights and queue history",
  media_previews: "Desktop media previews",
};

function catalog(): OfapiCollectionCatalogEntry[] {
  return CATEGORY_IDS.map((id) => ({
    id,
    label: SERVER_LABELS[id],
    modes: id === "vault_files" ? ["off"] : id === "media_previews" ? ["off", "on_demand"] : ["off", "on_demand", "scheduled"],
    baseline: ["core_messages", "core_payments", "core_audience"].includes(id),
    consumers: id === "core_messages" ? ["chatters", "Agent Read"] : id === "media_previews" ? ["chatters"] : ["dashboard", "Agent Read"],
    supportsOneOff: !["core_messages", "core_payments", "core_audience", "media_previews"].includes(id),
    priceUnit: id === "vault_files" || id === "media_previews" ? "calls_and_bytes" : "physical_calls",
    prerequisites: id === "vault_files" ? ["owned source and explicit upload approval"] : ["active OFAPI page binding"],
    scope: "page",
    legacyOperations: [],
  }));
}

const PAGES = [
  { id: 7, label: "lora-of", accountId: "acct_1" },
  { id: 9, label: "lora-vip-of", accountId: "acct_2" },
];

function policy(
  pageId: number,
  category: OfapiCollectionCategory,
  overrides: Partial<OfapiCollectionPolicy> = {},
): OfapiCollectionPolicy {
  const baseline = ["core_messages", "core_payments", "core_audience"].includes(category);
  return {
    pageId,
    category,
    mode: baseline ? "scheduled" : "off",
    intervalMinutes: 1440,
    dailyCreditLimit: 200,
    maxCallsPerRun: 10,
    includeDetails: false,
    revision: 3,
    source: baseline ? "legacy_baseline" : "default_off",
    state: "baseline",
    backgroundPaused: false,
    usage: { callsToday: 0, reservedCreditsToday: 0, credits30d: 0, actualCreditsToday: null },
    lastCapturedAt: null,
    inFlight: 0,
    ...overrides,
  };
}

function snapshotFixture(overrides: Partial<OfapiCollectionSnapshot> = {}): OfapiCollectionSnapshot {
  const policies: OfapiCollectionPolicy[] = [];
  for (const page of PAGES) {
    for (const id of CATEGORY_IDS) {
      policies.push(policy(page.id, id));
    }
  }
  // Messages have real spend and a fresh capture; audience hit its limit on one page.
  const messages7 = policies.find((row) => row.pageId === 7 && row.category === "core_messages")!;
  messages7.usage = { callsToday: 18, reservedCreditsToday: 18, credits30d: 690, actualCreditsToday: 17 };
  messages7.lastCapturedAt = "2026-09-05T14:07:00.000Z";
  const audience9 = policies.find((row) => row.pageId === 9 && row.category === "core_audience")!;
  audience9.source = "page";
  audience9.state = "applied";
  audience9.dailyCreditLimit = 30;
  audience9.usage = { callsToday: 12, reservedCreditsToday: 30, credits30d: 168, actualCreditsToday: 30 };

  return {
    revision: 3,
    backgroundPaused: false,
    catalog: catalog(),
    pages: PAGES,
    policies,
    jobs: [],
    audit: [
      {
        revision: 3,
        actorUserId: 1,
        createdAt: "2026-09-05T14:10:00.000Z",
        changes: {
          expectedRevision: 2,
          changes: [{
            pageId: 9, category: "core_audience", mode: "scheduled",
            intervalMinutes: 1440, dailyCreditLimit: 30, maxCallsPerRun: 10, includeDetails: false,
          }],
        },
      },
    ],
    limitDescription: "Limits apply to new managed physical requests. Vendor events, external clients, accepted operations and variable prices can charge separately.",
    ...overrides,
  };
}

function settings(overrides: Partial<OfapiCollectionSettings> = {}): OfapiCollectionSettings {
  return {
    pageId: null,
    category: "posts_comments",
    mode: "scheduled",
    intervalMinutes: 360,
    dailyCreditLimit: 40,
    maxCallsPerRun: 10,
    includeDetails: false,
    ...overrides,
  };
}

function withRouter(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, element));
}

function renderTab() {
  return withRouter(createElement(CollectionTab));
}

const idleMutation = () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() });

// ru-RU number formatting uses U+00A0 as the thousands separator.
const NBSP = " ";

beforeEach(() => {
  for (const mock of Object.values(collectionMocks)) {
    if (typeof mock === "function") mock.mockReset();
  }
  usersMocks.useAdminUsers.mockReset();
  usersMocks.useAdminUsers.mockReturnValue({ data: [{ id: 1, username: "owner" }] });
  collectionMocks.useOfapiCollectionPreview.mockImplementation(idleMutation);
  collectionMocks.useOfapiCollectionApply.mockImplementation(idleMutation);
  collectionMocks.useOfapiCollectionJobCreate.mockImplementation(idleMutation);
  collectionMocks.useOfapiCollectionJobResume.mockImplementation(idleMutation);
  collectionMocks.useOfapiCollectionJobFinishIncomplete.mockImplementation(idleMutation);
  collectionMocks.useAdminOfapiWebhookStatus.mockReturnValue({
    data: {
      configured: true,
      registrationState: "stable",
      registrationError: null,
      pendingRegistration: null,
      endpointUrl: "https://gosling-agency.ru/api/v1/ofapi/webhook",
      externalWebhookId: "wh_4321abcdef24d",
      accountScope: "global",
      events: ["messages.received", "messages.sent", "transactions.new", "users.online", "accounts.disconnected"],
      signingSecretMask: "••••",
      updatedAt: "2026-09-05T14:10:00.000Z",
      pages: [{ ofapiAccountId: "acct_1" }, { ofapiAccountId: null }],
      credit: { lastBalance: 1099, lastBalanceAt: null, spentToday: 0 },
    },
    isLoading: false,
    isError: false,
    error: null,
  });
});

describe("CollectionTab (static render)", () => {
  it("shows Finish only for a server-authorized paused scheduled read in the shared Collection screen", () => {
    const fixture = snapshotFixture();
    fixture.jobs = [{ id: "scheduled-read", pageId: 7, category: "posts_comments", state: "paused",
      maxCredits: 10, maxCalls: 10, maxBytes: 1000, usedCredits: 2, usedCalls: 2, usedBytes: 200,
      createdAt: "2026-09-07T05:00:00Z", reason: "Vendor HTTP 404; response captured", canFinishIncomplete: true }];
    const markup = withRouter(createElement(JobsCard, { snapshot: fixture, scope: { kind: "all" } }));
    expect(markup).toContain("Завершить неполный проход");
    expect(markup).toContain("Vendor HTTP 404; response captured");
    expect(markup).toContain("Проходы сбора и разовые задачи");
    fixture.jobs[0]!.canFinishIncomplete = false;
    expect(withRouter(createElement(JobsCard, { snapshot: fixture, scope: { kind: "all" } }))).not.toContain("Завершить неполный проход");
  });
  it("explains preserved uncertain charges and the next scheduled run before confirmation", () => {
    const job = { id: "scheduled-read", pageId: 7, category: "posts_comments" as const, state: "paused",
      maxCredits: 10, maxCalls: 10, maxBytes: 1000, usedCredits: 2, usedCalls: 2, usedBytes: 200,
      createdAt: "2026-09-07T05:00:00Z", reason: "response body read failed", canFinishIncomplete: true };
    const props = { job, pageLabel: "lora-of", pending: false, error: null, onClose: vi.fn(), onConfirm: vi.fn() };
    const markup = renderToStaticMarkup(createElement(FinishIncompleteRunModal, props));
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("lora-of");
    expect(markup).toContain("учёт неподтверждённых списаний останутся");
    expect(markup).toContain("по штатному расписанию, если сбор включён");
    expect(markup).toContain("Оставить на паузе");
    expect(props.onConfirm).not.toHaveBeenCalled();
    const pending = renderToStaticMarkup(createElement(FinishIncompleteRunModal, { ...props, pending: true }));
    expect(pending).toContain("Завершаем…");
    expect(pending.match(/disabled=""/g)).toHaveLength(2);
    expect(renderToStaticMarkup(createElement(FinishIncompleteRunModal, { ...props, error: "Изменения в другом окне" }))).toContain('role="alert"');
  });
  it("renders registry-driven groups, modes, spend and the policy pill without any fabricated telemetry", () => {
    collectionMocks.useAdminOfapiCollection.mockReturnValue({
      data: snapshotFixture(), isLoading: false, isFetching: false, error: null, refetch: vi.fn(),
    });
    const markup = renderTab();

    expect(markup).toContain("Сбор данных OFAPI");
    // Owner-facing groups in the decided order.
    expect(markup.indexOf("Действующая конфигурация")).toBeLessThan(markup.indexOf("Доступно к включению"));
    expect(markup.indexOf("Доступно к включению")).toBeLessThan(markup.indexOf("Только разовые задачи"));
    // Baseline categories run under the legacy configuration; new ones are off.
    expect(markup).toContain("Сообщения");
    expect(markup).toContain("baseline · прежняя конфигурация");
    expect(markup).toContain("Посты и комментарии");
    expect(markup).toContain("выключено по умолчанию");
    expect(markup).toContain("доступно: по запросу, расписание");
    // vault_files: registry offers only "off" → no radio, only the bounded job.
    expect(markup).toContain("Загрузка своих медиа");
    expect(markup).toContain('href="/ofapi-media"');
    expect(markup).not.toContain("Локальные копии медиа");
    expect(markup).toContain("Разовая задача");
    expect(markup).toContain("Загрузить свой файл…");
    expect(markup).not.toContain('type="radio"');
    // Budget-exhausted row is a state with its own wording, not a hidden error.
    expect(markup).toContain("лимит дня достигнут");
    expect(markup).toContain("30 из 30 кр · продолжит 00:00 UTC");
    // Spend comes from the GET only; unconfirmed actuals say so.
    expect(markup).toContain("зарезервировано сегодня под фоновый сбор");
    expect(markup).toContain("факт не подтверждён");
    expect(markup).toContain("690");
    expect(markup).toContain("Полная картина списаний");
    expect(markup).toContain('href="/ofapi-credits"');
    // The server's own limit wording is shown verbatim, never a client constant.
    expect(markup).toContain("Limits apply to new managed physical requests");
    // Policy pill: revision + applied time + actor resolved from users.
    expect(markup).toContain("Политика v3 · применена 2026-09-05 14:10 UTC · owner");
    // No USD, no estimate numbers, no vendor balance on this screen.
    expect(markup).not.toContain("≈ $");
    expect(markup).not.toContain("на балансе команды");
    // Stop button is enabled (not paused) and the draft bar is absent.
    expect(markup).toContain("Остановить фоновый сбор");
    expect(markup).not.toContain("в черновике");
    // Webhook card is read-only: no switches at all.
    expect(markup).toContain("одна регистрация на все OF-страницы");
    expect(markup).toContain("wh_43…24d");
    expect(markup).toContain("в текущем наборе");
    expect(markup).not.toContain('role="switch"');
    // Journal summary line.
    expect(markup).toContain("Журнал изменений");
    expect(markup).toContain("1 запись · последняя: v3, 2026-09-05 14:10 UTC, owner");
  });

  it("shows the global pause banner, keeps modes and disables the stop button", () => {
    const snapshot = snapshotFixture({ backgroundPaused: true, revision: 4, audit: [
      { revision: 4, actorUserId: 1, createdAt: "2026-09-05T16:40:00.000Z", changes: { expectedRevision: 3, changes: [], backgroundPaused: true } },
    ] });
    for (const row of snapshot.policies) row.backgroundPaused = true;
    snapshot.policies[0]!.inFlight = 1;
    collectionMocks.useAdminOfapiCollection.mockReturnValue({
      data: snapshot, isLoading: false, isFetching: false, error: null, refetch: vi.fn(),
    });
    const markup = renderTab();

    expect(markup).toContain("Фоновый сбор остановлен · owner · 2026-09-05 16:40 UTC");
    expect(markup).toContain("1 запрос ещё в полёте");
    expect(markup).toContain("Возобновить сбор");
    expect(markup).toContain("Политика v4 · глобальная пауза");
    expect(markup).toContain("глобальная пауза · режим сохранён");
    expect(markup).toContain("остановлена глобальной паузой");
    // Modes are preserved, not flipped to off.
    expect(markup).toContain("Прежние настройки");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Остановить фоновый сбор<\/button>/);
  });

  it("renders the skeleton while loading and an error panel with retry when the GET fails", () => {
    collectionMocks.useAdminOfapiCollection.mockReturnValue({
      data: undefined, isLoading: true, isFetching: true, error: null, refetch: vi.fn(),
    });
    expect(renderTab()).toContain("animate-pulse");

    collectionMocks.useAdminOfapiCollection.mockReturnValue({
      data: undefined, isLoading: false, isFetching: false, error: new Error("boom"), refetch: vi.fn(),
    });
    const markup = renderTab();
    expect(markup).toContain("Настройки сбора недоступны");
    expect(markup).toContain("boom");
    expect(markup).toContain("Повторить");
    expect(markup).not.toContain("Проверить и применить");
  });

  it("shows an empty-pages message instead of an empty table", () => {
    collectionMocks.useAdminOfapiCollection.mockReturnValue({
      data: snapshotFixture({ pages: [], policies: [] }), isLoading: false, isFetching: false, error: null, refetch: vi.fn(),
    });
    expect(renderTab()).toContain("OF-страниц нет");
  });
});

describe("CategoryEditor (static render)", () => {
  it("offers only the registry's modes and warns about the legacy baseline", () => {
    const snapshot = snapshotFixture();
    const view = buildCategoryView(snapshot, { kind: "all" }, snapshot.catalog.find((row) => row.id === "core_audience")!);
    const markup = withRouter(createElement(CategoryEditor, {
      snapshot, scope: { kind: "all" }, view, draftEntry: null, jobs: [], onChange: vi.fn(), onCreateJob: vi.fn(),
    }));
    expect(markup.match(/type="radio"/g)?.length).toBe(3);
    expect(markup).toContain("По запросу");
    expect(markup).toContain("Открытие страницы не считается запросом");
    expect(markup).toContain("прежней конфигурации (baseline)");
    // A page override exists on lora-vip-of: the default-scope edit will not displace it.
    expect(markup).toContain("Своя настройка есть у: lora-vip-of");
    expect(markup).toContain("Сейчас по страницам");
    expect(markup).not.toContain("Создать задачу…");
  });

  it("shows the limit fields and an unmeasured (never zero) estimate once a draft enables a category", () => {
    const snapshot = snapshotFixture();
    const view = buildCategoryView(snapshot, { kind: "page", pageId: 7 }, snapshot.catalog.find((row) => row.id === "posts_comments")!);
    const draftEntry = { settings: settings({ pageId: 7 }), base: view.settings };
    const markup = withRouter(createElement(CategoryEditor, {
      snapshot, scope: { kind: "page", pageId: 7 }, view, draftEntry, jobs: [], onChange: vi.fn(), onCreateJob: vi.fn(),
    }));
    expect(markup).toContain("Режим · lora-of");
    expect(markup).toContain("каждые 6 ч");
    expect(markup).toContain("Дневной лимит категории, кр");
    expect(markup).toContain('value="40"');
    expect(markup).toContain("Запросов за запуск, не более");
    expect(markup).toContain("не измерена");
    expect(markup).toContain("Неизвестная цена не означает «бесплатно»");
    expect(markup).not.toContain("≈ 0");
    // Turning it off later stops nothing today: it is not collecting yet.
    expect(markup).toContain("Ничего не перестанет обновляться");
    expect(markup).toContain("Задач не было");
  });

  it("renders no radios for a one-off-only category and shows its prerequisite", () => {
    const snapshot = snapshotFixture();
    const view = buildCategoryView(snapshot, { kind: "page", pageId: 7 }, snapshot.catalog.find((row) => row.id === "vault_files")!);
    const markup = withRouter(createElement(CategoryEditor, {
      snapshot, scope: { kind: "page", pageId: 7 }, view, draftEntry: null, jobs: [], onChange: vi.fn(), onCreateJob: vi.fn(),
    }));
    expect(markup).not.toContain('type="radio"');
    expect(markup).toContain("Загрузка своего файла");
    expect(markup).toContain('href="/ofapi-media"');
    expect(markup).not.toContain("Создать задачу…");
    expect(markup).toContain("свой файл и отдельное подтверждение загрузки");
  });
});

describe("draft, preview, pause and conflict surfaces (static render)", () => {
  function draftWith(entries: Array<{ settings: OfapiCollectionSettings; base: OfapiCollectionSettings | null }>, revision = 3): CollectionDraft {
    const draft = emptyDraft(revision, { kind: "all" });
    for (const entry of entries) draft.entries[draftKey(entry.settings.pageId, entry.settings.category)] = entry;
    return draft;
  }

  it("draft bar lists was → will per change and blocks two enables per apply", () => {
    const snapshot = snapshotFixture();
    const one = draftWith([{ settings: settings(), base: settings({ mode: "off" }) }]);
    const markup = withRouter(createElement(DraftBar, {
      draft: one, snapshot, blockReason: draftBlockReason(one), busy: false, conflict: false,
      onReset: vi.fn(), onPreview: vi.fn(), onCompare: vi.fn(),
    }));
    expect(markup).toContain("1 изменение в черновике");
    expect(markup).toContain("Выключено → Расписание · каждые 6 ч · до 10 вызовов за запуск · лимит 40 кр/сутки");
    expect(markup).toContain("Проверить и применить");
    expect(markup).not.toContain("только одну включённую категорию");

    const two = draftWith([
      { settings: settings(), base: settings({ mode: "off" }) },
      { settings: settings({ category: "visitors", mode: "on_demand" }), base: settings({ category: "visitors", mode: "off" }) },
    ]);
    const blocked = withRouter(createElement(DraftBar, {
      draft: two, snapshot, blockReason: draftBlockReason(two), busy: false, conflict: false,
      onReset: vi.fn(), onPreview: vi.fn(), onCompare: vi.fn(),
    }));
    expect(blocked).toContain("только одну включённую категорию");
    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>Проверить и применить<\/button>/);
  });

  it("draft bar switches to compare when the server revision moved on", () => {
    const snapshot = snapshotFixture({ revision: 5 });
    const draft = draftWith([{ settings: settings(), base: settings({ mode: "off" }) }], 3);
    const markup = withRouter(createElement(DraftBar, {
      draft, snapshot, blockReason: null, busy: false, conflict: true,
      onReset: vi.fn(), onPreview: vi.fn(), onCompare: vi.fn(),
    }));
    expect(markup).toContain("собран против v3, сервер уже на v5");
    expect(markup).toContain("Обновить и сравнить");
    expect(markup).not.toContain("Проверить и применить");
  });

  it("preview modal never shows an unknown cost as zero and names what stops", () => {
    const snapshot = snapshotFixture();
    const off = settings({ category: "core_audience", mode: "off" });
    const draft = draftWith([{ settings: off, base: settings({ category: "core_audience", mode: "scheduled", intervalMinutes: 1440, dailyCreditLimit: 200 }) }]);
    const body = buildChangeBody(draft);
    const markup = withRouter(createElement(PreviewModal, {
      snapshot, draft, body, pending: false, onClose: vi.fn(), onApply: vi.fn(),
      preview: {
        revision: 3, changes: body.changes, backgroundPaused: false,
        cost: { source: "unknown", estimatedCredits: null, maximumNewCreditsPerDay: 0 },
        consequences: ["core_audience: saved data remains readable; new refreshes stop."], inFlight: 2,
      },
    }));
    expect(markup).toContain("Проверить изменения");
    expect(markup).toContain("Изменится · 1");
    expect(markup).toContain("Аудитория");
    expect(markup).toContain("→");
    expect(markup).toContain("вебхук не меняется");
    expect(markup).toContain("Перестанет обновляться");
    expect(markup).toContain("Дашборд, Agent Read");
    expect(markup).toContain("не измерена");
    expect(markup).toContain("пустая оценка не означает «0»");
    expect(markup).not.toContain("≈ 0");
    expect(markup).toContain("В полёте 2 запроса");
    expect(markup).toContain("saved data remains readable");
    expect(markup).toContain("Политика v3 → v4");
    expect(markup).toContain(">Применить<");
  });

  it("preview modal states the scheduled ceiling when a category is enabled", () => {
    const snapshot = snapshotFixture();
    const draft = draftWith([{ settings: settings(), base: settings({ mode: "off" }) }]);
    const body = buildChangeBody(draft);
    const markup = withRouter(createElement(PreviewModal, {
      snapshot, draft, body, pending: false, onClose: vi.fn(), onApply: vi.fn(),
      preview: {
        revision: 3, changes: body.changes, backgroundPaused: false,
        cost: { source: "unknown", estimatedCredits: null, maximumNewCreditsPerDay: 40 }, consequences: [], inFlight: 0,
      },
    }));
    expect(markup).toContain("40 кр в сутки");
    expect(markup).toContain("Ничего: категории включаются");
  });

  it("pause modal lists exactly what stops and what keeps charging", () => {
    const snapshot = snapshotFixture();
    const markup = withRouter(createElement(PauseModal, {
      snapshot, resume: false, pending: false, onClose: vi.fn(), onApply: vi.fn(),
      preview: {
        revision: 3, changes: [], backgroundPaused: true,
        cost: { source: "unknown", estimatedCredits: null, maximumNewCreditsPerDay: 0 },
        consequences: ["Accepted exports/uploads and incoming webhooks may still charge after a pause."], inFlight: 1,
      },
    }));
    expect(markup).toContain("Остановить фоновый сбор?");
    expect(markup).toContain("Сообщения (2 страницы), Оплаты и подписки (2 страницы), Аудитория (2 страницы)");
    expect(markup).toContain("События вебхука");
    expect(markup).toContain("интерактивные запросы не блокируются паузой");
    expect(markup).toContain("1 запрос — завершение и списание кредитов возможны");
    expect(markup).toContain("incoming webhooks may still charge");
    expect(markup).not.toContain("все списания");
  });

  it("conflict modal shows was / server-now / draft and flags rows changed elsewhere", () => {
    const snapshot = snapshotFixture({ revision: 5 });
    // The server (another window) moved core_audience on both pages to on_demand.
    for (const row of snapshot.policies) {
      if (row.category === "core_audience") {
        row.mode = "on_demand"; row.dailyCreditLimit = 30; row.source = "default"; row.state = "applied";
      }
    }
    const base = settings({ category: "core_audience", mode: "scheduled", intervalMinutes: 1440, dailyCreditLimit: 200 });
    const draft = draftWith([
      { settings: settings({ category: "core_audience", mode: "off" }), base },
      { settings: settings({ category: "posts_comments" }), base: settings({ category: "posts_comments", mode: "off", intervalMinutes: 1440, dailyCreditLimit: 200 }) },
    ], 3);
    const markup = withRouter(createElement(ConflictModal, {
      draft, snapshot, refreshing: false, onClose: vi.fn(), onRebase: vi.fn(), onDiscard: vi.fn(),
    }));
    expect(markup).toContain("собран против v3; сервер сейчас на v5");
    expect(markup).toContain("Сравнение · 2");
    expect(markup).toContain("изменено там");
    expect(markup).toContain("Изменено другим окном: 1 из 2");
    expect(markup).toContain("Продолжить с v5");
    expect(markup).toContain("Сбросить черновик");
  });
});

describe("collection model helpers", () => {
  it("removes a draft entry that returns to its base value and serialises round-trip", () => {
    const base = settings({ mode: "off", intervalMinutes: 1440, dailyCreditLimit: 200 });
    const draft = emptyDraft(3, { kind: "all" });
    draft.entries[draftKey(null, "posts_comments")] = { settings: settings(), base };
    expect(draftEnableCount(draft)).toBe(1);
    expect(sameSettings(base, settings())).toBe(false);
    expect(sameSettings(base, { ...base })).toBe(true);
    const restored = restoreDraft(serializeDraft(draft));
    expect(restored).toEqual(draft);
    expect(buildChangeBody(draft)).toEqual({ expectedRevision: 3, changes: [settings()] });
    expect(buildChangeBody(draft, true)).toEqual({ expectedRevision: 3, changes: [settings()], backgroundPaused: true });
  });

  it("drops malformed stored drafts instead of trusting them", () => {
    expect(restoreDraft(null)).toBeNull();
    expect(restoreDraft("not json")).toBeNull();
    expect(restoreDraft(JSON.stringify({ revision: "3", scope: { kind: "all" }, entries: {} }))).toBeNull();
    expect(restoreDraft(JSON.stringify({ revision: 3, scope: { kind: "page" }, entries: {} }))).toBeNull();
    expect(restoreDraft(JSON.stringify({ revision: 3, scope: { kind: "all" }, entries: { x: { settings: { mode: "pilot" }, base: null } } }))).toBeNull();
    expect(restoreDraft(JSON.stringify({ revision: 3, scope: { kind: "page", pageId: 7 }, entries: {} })))
      .toEqual({ revision: 3, scope: { kind: "page", pageId: 7 }, entries: {} });
  });

  it("aggregates the 'all pages' scope honestly: uniform vs mixed, overrides, totals", () => {
    const snapshot = snapshotFixture();
    const views = buildCategoryViews(snapshot, { kind: "all" });
    const messages = views.find((view) => view.entry.id === "core_messages")!;
    expect(messages.uniform).toBe(true);
    expect(messages.settings?.pageId).toBeNull();
    expect(messages.usage.credits30d).toBe(690);
    expect(messages.usage.actualCreditsToday).toBe(17);
    expect(messages.lastCapturedAt).toBe("2026-09-05T14:07:00.000Z");
    const audience = views.find((view) => view.entry.id === "core_audience")!;
    expect(audience.uniform).toBe(false);
    expect(audience.settings).toBeNull();
    expect(audience.overridePageIds).toEqual([9]);
    expect(audience.sources.sort()).toEqual(["legacy_baseline", "page"]);
    const totals = usageTotals(views.flatMap((view) => view.policies));
    expect(totals.reservedCreditsToday).toBe(48);
    expect(totals.actualCreditsToday).toBe(47);
    // Page scope narrows to one policy.
    const page9 = buildCategoryView(snapshot, { kind: "page", pageId: 9 }, snapshot.catalog[2]!);
    expect(page9.policies).toHaveLength(1);
    expect(page9.settings?.pageId).toBe(9);
  });

  it("groups by the owner's order and sorts inside a group by 30-day spend", () => {
    const snapshot = snapshotFixture();
    const groups = groupCategoryViews(buildCategoryViews(snapshot, { kind: "all" }));
    expect(groups.running.map((view) => view.entry.id)).toEqual(["core_messages", "core_audience", "core_payments"]);
    expect(groups.available.map((view) => view.entry.id)).toEqual([
      "posts_comments", "visitors", "tracking_links", "smart_links", "vault_catalog", "balances", "profile_notifications", "content_history",
      "media_previews",
    ]);
    expect(groups.one_off.map((view) => view.entry.id)).toEqual(["vault_files"]);
    expect(groups.unavailable).toEqual([]);
    // A registry entry with no modes and no one-off lands in "unavailable" with no control.
    const stub = snapshotFixture({ catalog: [{ ...catalog()[3]!, modes: [], supportsOneOff: false }] });
    const view = buildCategoryViews(stub, { kind: "all" })[0]!;
    expect(view.group).toBe("unavailable");
    expect(rowState(view, false)).toEqual({ tone: "off", label: "ещё не реализовано", detail: "категория из плана без работающего кода" });
  });

  it("derives one row state per situation", () => {
    const snapshot = snapshotFixture();
    const view = (id: OfapiCollectionCategory, scope: { kind: "all" } | { kind: "page"; pageId: number } = { kind: "all" }) =>
      buildCategoryView(snapshot, scope, snapshot.catalog.find((row) => row.id === id)!);
    expect(rowState(view("posts_comments"), false)).toMatchObject({ tone: "off", label: "выключено" });
    expect(rowState(view("core_messages"), true)).toMatchObject({ tone: "danger", label: "остановлено" });
    expect(rowState(view("core_messages"), false)).toMatchObject({ tone: "muted", label: "прежняя конфигурация", detail: "Активность и лимиты задаёт прежний сборщик" });
    expect(rowState(view("core_audience", { kind: "page", pageId: 9 }), false)).toMatchObject({ tone: "warning", label: "лимит дня достигнут" });
    // Legacy-baseline rows never claim a budget pause: their old budgets still govern.
    const legacyHot = snapshotFixture();
    const row = legacyHot.policies.find((candidate) => candidate.pageId === 7 && candidate.category === "core_payments")!;
    row.usage.reservedCreditsToday = 999;
    expect(rowState(buildCategoryView(legacyHot, { kind: "page", pageId: 7 }, legacyHot.catalog[1]!), false).label).toBe("прежняя конфигурация");
    row.inFlight = 3;
    expect(rowState(buildCategoryView(legacyHot, { kind: "page", pageId: 7 }, legacyHot.catalog[1]!), false)).toMatchObject({ tone: "accent", label: "в работе", detail: "3 запроса в полёте" });
  });

  it("describes the policy pill from server state, apply phase and conflict", () => {
    const snapshot = snapshotFixture();
    expect(describePolicyPill({ snapshot, applyPhase: { kind: "idle" }, conflict: false, actorName: "owner" }))
      .toEqual({ tone: "ok", text: "Политика v3 · применена 2026-09-05 14:10 UTC · owner" });
    expect(describePolicyPill({ snapshot, applyPhase: { kind: "saved", revision: 4 }, conflict: false, actorName: null }))
      .toEqual({ tone: "warning", text: "v4 · применяется · ждём readback" });
    // Readback reached: the pill reports the applied revision even before the
    // journal row is in the snapshot.
    expect(describePolicyPill({ snapshot: { ...snapshot, revision: 4 }, applyPhase: { kind: "saved", revision: 4 }, conflict: false, actorName: null }))
      .toEqual({ tone: "ok", text: "Политика v4 · применена" });
    expect(describePolicyPill({ snapshot, applyPhase: { kind: "error", message: "x" }, conflict: false, actorName: null }))
      .toEqual({ tone: "danger", text: "v3 · ошибка применения" });
    expect(describePolicyPill({ snapshot, applyPhase: { kind: "idle" }, conflict: true, actorName: null }))
      .toEqual({ tone: "accent", text: "изменено в другом окне" });
    expect(describePolicyPill({ snapshot: { ...snapshot, backgroundPaused: true }, applyPhase: { kind: "idle" }, conflict: false, actorName: null }))
      .toEqual({ tone: "danger", text: "Политика v3 · глобальная пауза" });
    expect(describePolicyPill({ snapshot: { ...snapshot, revision: 0, audit: [] }, applyPhase: { kind: "idle" }, conflict: false, actorName: null }).text)
      .toBe("Политика v0 · baseline, изменений не было");
  });

  it("compares a stale draft against the current snapshot", () => {
    const snapshot = snapshotFixture({ revision: 5 });
    const base = settings({ category: "core_messages", mode: "scheduled", intervalMinutes: 1440, dailyCreditLimit: 200 });
    const draft = emptyDraft(3, { kind: "all" });
    draft.entries[draftKey(null, "core_messages")] = { settings: settings({ category: "core_messages", mode: "off" }), base };
    let rows = diffDraftAgainstSnapshot(draft, snapshot);
    expect(rows[0]?.changedElsewhere).toBe(false);
    expect(rows[0]?.current).toMatchObject({ mode: "scheduled", pageId: null });
    for (const row of snapshot.policies) if (row.category === "core_messages") row.intervalMinutes = 60;
    rows = diffDraftAgainstSnapshot(draft, snapshot);
    expect(rows[0]?.changedElsewhere).toBe(true);
  });

  it("parses audit rows defensively and summarises them in plain language", () => {
    const snapshot = snapshotFixture();
    expect(summarizeAudit(snapshot.audit[0]!, snapshot.pages))
      .toBe("Аудитория (lora-vip-of): Расписание · каждые 24 ч · до 10 вызовов за запуск · лимит 30 кр/сутки");
    expect(summarizeAudit({ revision: 9, actorUserId: 1, createdAt: "2026-09-05T00:00:00.000Z", changes: { expectedRevision: 8, changes: [], backgroundPaused: true } }, snapshot.pages))
      .toBe("фоновый сбор: остановлен");
    expect(summarizeAudit({ revision: 9, actorUserId: 1, createdAt: "2026-09-05T00:00:00.000Z", changes: "garbage" }, snapshot.pages))
      .toBe("запись без разбираемых изменений");
    expect(parseAuditChanges({ changes: [{ mode: "pilot" }] })).toEqual({ changes: [], backgroundPaused: undefined });
  });

  it("summarises what a global stop covers", () => {
    const snapshot = snapshotFixture();
    snapshot.policies[0]!.inFlight = 2;
    const summary = stopSummary(snapshot);
    expect(summary.scheduled).toEqual([
      { category: "core_messages", pages: 2 }, { category: "core_payments", pages: 2 }, { category: "core_audience", pages: 2 },
    ]);
    expect(summary.onDemand).toEqual([]);
    expect(summary.inFlight).toBe(2);
  });

  it("formats intervals, bytes, settings, job inputs and webhook ids", () => {
    expect(intervalLabel(15)).toBe("15 мин");
    expect(intervalLabel(60)).toBe("1 ч");
    expect(intervalLabel(360)).toBe("6 ч");
    expect(intervalLabel(1440)).toBe("24 ч");
    expect(intervalLabel(4320)).toBe("3 суток");
    expect(intervalLabel(10080)).toBe("1 неделя");
    expect(formatBytes(512)).toBe("512 Б");
    expect(formatBytes(100 * 1024 * 1024)).toBe("100 МБ");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1,5 ГБ");
    expect(describeSettings(settings({ mode: "off" }))).toBe("Выключено");
    expect(describeSettings(settings({ mode: "on_demand", includeDetails: true }))).toBe("По запросу · лимит 40 кр/сутки · с detail-запросами");
    expect(localDateTimeToIso("")).toBeNull();
    expect(localDateTimeToIso("garbage")).toBeNull();
    expect(localDateTimeToIso("2026-09-01T12:00")).toMatch(/^2026-09-01T\d{2}:\d{2}:00\.000Z$/);
    expect(parseSelection(" a \n\nb, c ")).toEqual(["a", "b", "c"]);
    expect(maskWebhookId(null)).toBe("—");
    expect(maskWebhookId("wh_4321abcdef24d")).toBe("wh_43…24d");
    expect(groupWebhookEvents(["messages.received", "messages.sent", "accounts.disconnected"])).toEqual([
      { group: "messages", label: "Сообщения", events: ["messages.received", "messages.sent"] },
      { group: "accounts", label: "Аккаунт", events: ["accounts.disconnected"] },
    ]);
    // Thousands separator sanity for the ru-RU formatter used on the screen.
    expect((12_345).toLocaleString("ru-RU")).toBe(`12${NBSP}345`);
  });
});

describe("navigation and the Credits link", () => {
  it("knows the collection tab", () => {
    expect(resolveSettingsTab("collection")).toBe("collection");
    expect(buildSettingsRoute("collection")).toBe("/settings?tab=collection");
  });

  it("OFAPI Credits links to the collection settings", () => {
    creditsQueryMocks.useAdminOfapiCreditsDaily.mockReturnValue({ data: { days: [], balance: [], refills: [], byOperation: [], byPage: [] }, isLoading: false });
    creditsQueryMocks.useAdminOfapiCreditsLedger.mockReturnValue({ data: { total: 0, pageOptions: [], rows: [] }, isLoading: false });
    creditsQueryMocks.useAdminOfapiSpendComparison.mockReturnValue({ data: { summary: [], byPage: [], samples: [], limitations: [] }, isLoading: false });
    creditsQueryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      isLoading: false, isError: false,
      data: {
        enabled: true,
        balance: { value: 1099, observedAt: "2026-09-05T12:41:00.000Z" },
        today: { day: "2026-09-05", total: 0, bySource: { rest: 0, webhookAccrual: 0, external: 0, adjustment: 0 } },
        budgets: [{ stream: "dm", spentToday: 84, dailyCeiling: 500, state: "ok", retryAt: null }],
        floor: { value: 500, blocked: false },
        forecast: { avgDailySpend7d: 212, daysLeft: 31, runOutDate: "2026-07-13" },
        incidents: [], reconciliation: { lastRunAt: "2026-09-05T12:00:00.000Z", lastDriftCredits: 0 }, accrual: { lastPostedDay: "2026-09-04" },
      },
    });
    const markup = withRouter(createElement(OfapiCreditsPage));
    expect(markup).toContain("Настройки сбора");
    expect(markup).toContain('href="/settings?tab=collection"');
  });
});
