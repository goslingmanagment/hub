import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  useAdminOfapiCreditsSummary: vi.fn(),
  useAdminOfapiCreditsDaily: vi.fn(),
  useAdminOfapiCreditsLedger: vi.fn(),
  useAdminOfapiSpendComparison: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { OfapiCreditsPage } from "../apps/dashboard/src/pages/OfapiCreditsPage.tsx";

// The page renders <Link> (deep-links to Settings), so it needs a Router context.
function renderPage() {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(OfapiCreditsPage)),
  );
}

// ru-RU number formatting uses U+00A0 as the thousands separator.
const NBSP = "\u00A0";

const emptyDaily = {
  days: [],
  balance: [],
  refills: [],
  byOperation: [],
  byPage: [],
};

function summaryFixture(overrides?: Partial<Record<string, unknown>>) {
  return {
    enabled: true,
    balance: { value: 23_950, observedAt: "2026-06-12T12:41:00.000Z" },
    today: {
      day: "2026-06-12",
      total: 137,
      bySource: { rest: 92, webhookAccrual: 40, external: 5, adjustment: 0 },
    },
    budgets: [{
      stream: "dm",
      spentToday: 84,
      dailyCeiling: 500,
      state: "ok",
      retryAt: null,
    }],
    floor: { value: 500, blocked: false },
    forecast: { avgDailySpend7d: 212, daysLeft: 31, runOutDate: "2026-07-13" },
    incidents: [],
    reconciliation: { lastRunAt: "2026-06-12T12:00:00.000Z", lastDriftCredits: 0 },
    accrual: { lastPostedDay: "2026-06-11" },
    ...overrides,
  };
}

describe("OfapiCreditsPage", () => {
  beforeEach(() => {
    queryMocks.useAdminOfapiCreditsSummary.mockReset();
    queryMocks.useAdminOfapiCreditsDaily.mockReset();
    queryMocks.useAdminOfapiCreditsLedger.mockReset();
    queryMocks.useAdminOfapiSpendComparison.mockReset();
    queryMocks.useAdminOfapiCreditsDaily.mockReturnValue({ data: emptyDaily, isLoading: false });
    queryMocks.useAdminOfapiCreditsLedger.mockReturnValue({
      data: { total: 0, pageOptions: [], rows: [] },
      isLoading: false,
    });
    // The projection-accuracy panel is collapsed by default, so its body/hook
    // does not mount in a static render; provide a benign default anyway.
    queryMocks.useAdminOfapiSpendComparison.mockReturnValue({
      data: { summary: [], byPage: [], samples: [], limitations: [] },
      isLoading: false,
    });
  });

  it("answers balance, runway, and top-up in the hero card", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain("Кредиты OFAPI");
    expect(markup).toContain("Баланс");
    expect(markup).toContain(`23${NBSP}950`);
    expect(markup).toContain("проверен 12:41 UTC");
    expect(markup).toContain("Хватит на");
    expect(markup).toContain("~31");
    expect(markup).toContain("закончатся ~13 июля");
    expect(markup).toContain("212 кр/день");
    // No refill recommendation in the payload → the top-up slot explains itself.
    expect(markup).toContain("Пополнение");
    expect(markup).toContain("появится после нескольких дней истории трат");
    expect(markup).not.toContain("Журнал кредитов выключен");
    // With no configured credit price, USD estimates stay hidden.
    expect(markup).not.toContain("≈ $");
    // A healthy page raises no alarm banner.
    expect(markup).not.toContain('role="alert"');
  });

  it("keeps an unexplained balance drop visible without presenting it as recurring spend", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({ forecast: {
        basis: "recorded_activity", avgDailySpend7d: 100, daysLeft: 10,
        runOutDate: "2026-06-22", monthToDateSpend: 100, monthEndProjection: 1000,
        monthUnverifiedResidualCredits: 38_795,
        unverifiedResidual: { credits: 38_795, from: "2026-06-05T12:00:00.000Z", to: "2026-06-12T12:00:00.000Z" },
        refillRecommendation: { targetDays: 30, credits: 0 },
      } }), isLoading: false, isError: false,
    });
    const markup = renderPage();
    expect(markup).toContain("Прогноз по операциям");
    expect(markup).toContain("Необъяснённая разница баланса в прогноз не включена");
    expect(markup).toContain(`38${NBSP}795`);
    expect(markup).toContain("2026-06-05 12:00 UTC");
    expect(markup).toContain("Уточнить расход");
    expect(markup).toContain("Фактический расход может быть выше прогноза");
  });

  it("shows today's spend with a per-source split and labelled budget meters", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain("Учтено сегодня · 2026-06-12");
    expect(markup).toContain("137");
    // Only non-zero sources are listed (adjustment 0 is omitted).
    expect(markup).toContain("Приложение");
    expect(markup).toContain("Вебхуки");
    expect(markup).toContain("Сверка баланса");
    // Budget meters use plain-language stream names.
    expect(markup).toContain("Синк сообщений");
    expect(markup).toContain("84 из 500 кр");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain("дневной бюджет: 84 из 500 кредитов");
    // The floor reads as what it does, not "floor 500 OK".
    expect(markup).toContain("Порог автостопа: 500 кр");
    expect(markup).toContain("остановятся");
  });

  it("shows negative corrections alongside the net daily total", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({ today: {
        day: "2026-06-12", total: 0,
        bySource: { rest: 1, adjustment: -1, webhookAccrual: 0, external: 0 },
      } }), isLoading: false, isError: false,
    });
    const markup = renderPage();
    expect(markup).toContain("Приложение 1");
    expect(markup).toContain("Корректировки -1");
    expect(markup).not.toContain("Сегодня пока ничего не потрачено");
  });

  it("keeps a negative net budget amount visible while clamping its visual meter", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({ budgets: [{
        stream: "dm", spentToday: -25, dailyCeiling: 500, state: "ok", retryAt: null,
      }] }), isLoading: false, isError: false,
    });
    const markup = renderPage();
    expect(markup).toContain("-25 из 500 кр");
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('style="width:0%"');
    expect(markup).not.toContain('style="width:-');
  });

  it("omits percentage shares for a mixed-sign operation window", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(), isLoading: false, isError: false,
    });
    queryMocks.useAdminOfapiCreditsDaily.mockReturnValue({
      data: { ...emptyDaily, byOperation: [
        { operation: "ofapi_chats", requests: 1, credits: 10 },
        { operation: "ofapi_chat_messages", requests: 0, credits: -9 },
      ] }, isLoading: false, isError: false,
    });
    const markup = renderPage();
    expect(markup).toContain(">-9</td>");
    expect(markup).toContain(">10</td>");
    expect(markup).not.toContain("1000%");
    expect(markup).not.toContain("-900%");
    expect(markup).not.toContain('style="width:-');
  });

  it("keeps system health collapsed and quiet while everything passes", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain("Состояние системы");
    expect(markup).toContain("Всё в порядке");
    expect(markup).toContain("баланс сверен 12:00 UTC");
    // Collapsed → the ops detail rows are not mounted.
    expect(markup).not.toContain("Сверен с провайдером");
    expect(markup).not.toContain("Точность проекций");
  });

  it("renders the pending current-day webhook estimate with today's spend", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({
        accrual: {
          lastPostedDay: "2026-06-11",
          pendingToday: { day: "2026-06-12", eventCount: 4464, estimatedCredits: 45 },
        },
      }),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain("~45 кр за");
    expect(markup).toContain(`4${NBSP}464`);
    expect(markup).toContain("ещё не проведены");
  });

  it("shows the disabled notice pointing at Settings > Configuration", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({ enabled: false }),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain("Журнал кредитов выключен");
    expect(markup).toContain("Настройки → Конфигурация");
    expect(markup).toContain("Открыть конфигурацию");
    expect(markup).toContain("config-ofapiCreditLedgerEnabled");
    expect(markup).not.toContain("OFAPI_CREDIT_LEDGER_ENABLED");
    // Ledger-derived sections are hidden with the flag off.
    expect(markup).not.toContain("Движение кредитов по дням");
    expect(markup).not.toContain("Куда уходят кредиты");
    expect(markup).not.toContain("Журнал операций");
  });

  it("explains a paused stream and raises the incident banner", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({
        budgets: [{
          stream: "dm",
          spentToday: 500,
          dailyCeiling: 500,
          state: "budget_exhausted",
          retryAt: "2026-06-13T00:00:00.000Z",
        }],
        incidents: [{
          kind: "ofapi_burn_rate",
          openedAt: "2026-06-12T11:00:00.000Z",
          errorSummary: "OFAPI spent 400 credits in the trailing hour",
        }],
      }),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    // The incident is a plain-language alarm, not a raw kind string.
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Кредиты сгорают необычно быстро");
    expect(markup).toContain("OFAPI spent 400 credits in the trailing hour");
    // The exhausted budget reads as paused with a resume time on its meter.
    expect(markup).toContain("дневной бюджет исчерпан");
    expect(markup).toContain("Продолжит в 2026-06-13 00:00 UTC");
    // System health opens itself and reports the paused stream.
    expect(markup).toContain("Требует внимания");
    expect(markup).toContain("Синк сообщений на паузе");
  });

  it("raises a floor-blocked alarm and reddens a short runway", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({
        floor: { value: 500, blocked: true },
        forecast: { avgDailySpend7d: 900, daysLeft: 2, runOutDate: "2026-06-14" },
      }),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Траты остановлены");
    expect(markup).toContain("порога автостопа");
    // A sub-3-day runway uses the danger tone.
    expect(markup).toContain("text-red-700");
    expect(markup).toContain("~2");
  });

  it("renders ledger rows with friendly labels and an accessible expander", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(),
      isLoading: false,
      isError: false,
    });
    queryMocks.useAdminOfapiCreditsLedger.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        total: 1,
        pageOptions: [{ pageId: 3, pageLabel: "lora-of" }],
        rows: [{
          id: 12,
          occurredAt: "2026-06-12T10:30:00.000Z",
          source: "rest",
          operation: "ofapi_chats",
          pageId: 3,
          pageLabel: "lora-of",
          httpStatus: 200,
          credits: 2,
          estimated: false,
          balanceAfter: 23_950,
          requestId: "ofapi_chats:abc",
          accrualDay: null,
        }],
      },
    });

    const markup = renderPage();
    // The raw operation id is translated but kept as a tooltip.
    expect(markup).toContain("Синк чатов");
    expect(markup).toContain('title="ofapi_chats"');
    expect(markup).toContain("Приложение");
    expect(markup).toContain("lora-of");
    expect(markup).toContain("2026-06-12 10:30 UTC");
    // Spend renders as its balance impact.
    expect(markup).toContain("-2");
    // The expander is a real button, not a bare clickable row.
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Развернуть детали записи"');
    expect(markup).toContain("aria-controls=");
  });

  it.each([
    ["rest", "Оценка при учёте HTTP-запроса; подтверждения и уточнения отражаются отдельными корректировками"],
    ["webhook_accrual", "Оценка по числу полученных вебхуков, а не подтверждённое списание OFAPI"],
    ["external", "Необъяснённое уменьшение баланса после учтённых расходов; источник не подтверждён"],
    ["refill", "Увеличение баланса после учтённых расходов; платёж не подтверждён"],
    ["adjustment", "Оценочная корректировка учёта кредитов"],
  ])("explains estimated %s rows using their actual evidence source", (source, explanation) => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(), isLoading: false, isError: false,
    });
    queryMocks.useAdminOfapiCreditsLedger.mockReturnValue({
      isLoading: false,
      data: {
        total: 1, pageOptions: [],
        rows: [{
          id: 12, occurredAt: "2026-06-12T10:30:00.000Z", source,
          operation: source === "rest" ? "ofapi_capture_posts" : null,
          pageId: null, pageLabel: null, httpStatus: source === "rest" ? 200 : null,
          credits: source === "refill" ? -100 : 1, estimated: true,
          balanceAfter: null, requestId: null, accrualDay: null,
        }],
      },
    });
    const markup = renderPage();
    expect(markup).toContain(explanation);
    expect(markup).not.toContain("точная сумма спишется с дневным начислением вебхуков");
  });

  it("offers an operation datalist from the breakdown operations", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(),
      isLoading: false,
      isError: false,
    });
    queryMocks.useAdminOfapiCreditsDaily.mockReturnValue({
      data: {
        ...emptyDaily,
        byOperation: [{ operation: "ofapi_chat_messages", requests: 3, credits: 6 }],
      },
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain("<datalist");
    expect(markup).toContain("list=");
    expect(markup).toContain('value="ofapi_chat_messages"');
  });

  it("deep-links every credit knob to Settings > Configuration", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({
        budgets: [
          { stream: "dm", spentToday: 84, dailyCeiling: 500, state: "ok", retryAt: null },
          { stream: "audience", spentToday: 12, dailyCeiling: 300, state: "ok", retryAt: null },
        ],
        // An open incident expands System health, which hosts the settings row.
        incidents: [{
          kind: "ofapi_webhook_silence",
          openedAt: "2026-06-12T11:00:00.000Z",
          errorSummary: null,
        }],
      }),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain("config-ofapiDmDailyCreditBudget");
    expect(markup).toContain("config-ofapiAudienceDailyCreditBudget");
    expect(markup).toContain("config-ofapiCreditFloor");
    expect(markup).toContain("config-ofapiBurnAlertCreditsPerHour");
    expect(markup).toContain("config-ofapiCreditMicroUsdPrice");
  });

  it("shows health detail rows in plain language once expanded", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({
        reconciliation: { lastRunAt: "2026-06-12T12:00:00.000Z", lastDriftCredits: 20 },
        accrual: { lastPostedDay: "2026-06-11" },
        incidents: [{
          kind: "ofapi_webhook_silence",
          openedAt: "2026-06-12T11:00:00.000Z",
          errorSummary: null,
        }],
      }),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain("Сверен с провайдером 2026-06-12 12:00 UTC");
    expect(markup).toContain("расхождение 20 кр");
    expect(markup).toContain("Проведены по 2026-06-11.");
    expect(markup).toContain("Вебхуки замолчали");
    // The projection diagnostic lives inside health, collapsed until opened.
    expect(markup).toContain("Точность проекций");
    expect(markup).not.toContain("совпало ·");
  });

  it("shows scoped errors for charts, breakdown, and the activity log", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(),
      isLoading: false,
      isError: false,
    });
    queryMocks.useAdminOfapiCreditsDaily.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    queryMocks.useAdminOfapiCreditsLedger.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });

    const markup = renderPage();
    expect(markup).toContain("Не удалось загрузить графики");
    expect(markup).toContain("Не удалось загрузить разбивку");
    expect(markup).toContain("Не удалось загрузить журнал");
    expect(markup).toContain("Повторить");
    // A failed ledger fetch must not read as an empty result.
    expect(markup).not.toContain("Ничего не найдено");
  });

  it("shows USD estimates and per-page ROI once a credit price is configured", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({ pricing: { microUsdPerCredit: 10_000 } }),
      isLoading: false,
      isError: false,
    });
    queryMocks.useAdminOfapiCreditsDaily.mockReturnValue({
      data: {
        ...emptyDaily,
        byPage: [{ pageId: 3, pageLabel: "lora-of", credits: 100, revenueMills: 2500 }],
      },
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    // $0.01/credit: balance 23,950 = $239.50, spent 137 = $1.37, avg 212/day = $2.12.
    expect(markup).toContain("≈ $239.50");
    expect(markup).toContain("≈ $1.37");
    expect(markup).toContain("$2.12/день");
    // Per-page cost-vs-revenue: 100 cr costs $1.00, earned $2.50, ROI 2.5×.
    expect(markup).toContain("$1.00");
    expect(markup).toContain("$2.50");
    expect(markup).toContain("2.5×");
    // The "configure a price" nudge disappears once a price is set.
    expect(markup).not.toContain("чтобы видеть стоимость");
  });

  it("hides the USD cost columns and nudges when no price is configured", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(),
      isLoading: false,
      isError: false,
    });
    queryMocks.useAdminOfapiCreditsDaily.mockReturnValue({
      data: {
        ...emptyDaily,
        byOperation: [{ operation: "ofapi_chats", requests: 5, credits: 200 }],
        byPage: [{ pageId: 3, pageLabel: "lora-of", credits: 200, revenueMills: 2500 }],
      },
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    // No dash-filled Cost/ROI columns — they are omitted entirely.
    expect(markup).not.toContain(">Стоимость<");
    expect(markup).not.toContain(">ROI<");
    expect(markup).toContain("чтобы видеть стоимость");
    expect(markup).toContain("config-ofapiCreditMicroUsdPrice");
  });

  it("drills breakdown activity and page rows into the log filters", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(),
      isLoading: false,
      isError: false,
    });
    queryMocks.useAdminOfapiCreditsDaily.mockReturnValue({
      data: {
        ...emptyDaily,
        byOperation: [{ operation: "ofapi_chats", requests: 2, credits: 90 }],
        byPage: [{ pageId: 3, pageLabel: "lora-of", credits: 90, revenueMills: 0 }],
      },
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    // Friendly label on screen, raw id in the drill tooltip.
    expect(markup).toContain("Синк чатов");
    expect(markup).toContain('title="Показать в журнале: ofapi_chats"');
    expect(markup).toContain('title="Показать в журнале: lora-of"');
  });

  it("sources ledger page filter options from the uncapped ledger response", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(),
      isLoading: false,
      isError: false,
    });
    queryMocks.useAdminOfapiCreditsDaily.mockReturnValue({
      data: {
        ...emptyDaily,
        byPage: [{ pageId: 3, pageLabel: "lora-of", credits: 90, revenueMills: 0 }],
      },
      isLoading: false,
      isError: false,
    });
    queryMocks.useAdminOfapiCreditsLedger.mockReturnValue({
      data: {
        total: 0,
        pageOptions: [
          { pageId: 3, pageLabel: "lora-of" },
          { pageId: 9, pageLabel: "vip-of" },
        ],
        rows: [],
      },
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain('<option value="9">vip-of</option>');
  });

  it("offers a CSV export button in the activity log toolbar", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(),
      isLoading: false,
      isError: false,
    });
    queryMocks.useAdminOfapiCreditsLedger.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        total: 1,
        pageOptions: [{ pageId: 3, pageLabel: "lora-of" }],
        rows: [{
          id: 1,
          occurredAt: "2026-06-12T10:30:00.000Z",
          source: "rest",
          operation: "ofapi_chats",
          pageId: 3,
          pageLabel: "lora-of",
          httpStatus: 200,
          credits: 2,
          estimated: false,
          balanceAfter: 23_950,
          requestId: null,
          accrualDay: null,
        }],
      },
    });

    const markup = renderPage();
    expect(markup).toContain("Экспорт CSV");
  });

  it("raises the burn banner with named drivers when the window alerts", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({
        recentBurn: {
          windowMinutes: 60,
          total: 450,
          threshold: 300,
          alerting: true,
          topOperations: [{ operation: "ofapi_chats", requests: 40, credits: 300 }],
          topPages: [{ pageId: 3, pageLabel: "lora-of", credits: 150 }],
        },
      }),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Журнал показывает расход или разницу баланса");
    expect(markup).toContain("450 кр за последние");
    expect(markup).toContain("Синк чатов (300 кр)");
    expect(markup).toContain("lora-of (150 кр)");
  });

  it("keeps a quiet burn window out of the alarms", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({
        recentBurn: {
          windowMinutes: 60,
          total: 120,
          threshold: 300,
          alerting: false,
          topOperations: [],
          topPages: [],
        },
      }),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain("Всё в порядке");
    // The quiet window stays inside the collapsed health section.
    expect(markup).not.toContain("120 кр за последние");
  });

  it("recommends a top-up and reports the month trajectory", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({
        pricing: { microUsdPerCredit: 10_000 },
        forecast: {
          avgDailySpend7d: 100,
          daysLeft: 40,
          runOutDate: "2026-07-30",
          monthToDateSpend: 800,
          monthEndProjection: 2_000,
          refillRecommendation: { targetDays: 30, credits: 1_500 },
        },
      }),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain(`+1${NBSP}500`);
    expect(markup).toContain("чтобы хватило на 30 дней");
    expect(markup).toContain("≈ $15.00");
    expect(markup).toContain("Потрачено за месяц: 800 кр");
    expect(markup).toContain(`к концу месяца выйдет ~2${NBSP}000 кр`);
  });

  it("shows the runway as covered when no top-up is needed", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({
        forecast: {
          avgDailySpend7d: 100,
          daysLeft: 400,
          runOutDate: null,
          monthToDateSpend: 800,
          monthEndProjection: 2_000,
          refillRecommendation: { targetDays: 30, credits: 0 },
        },
      }),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain("Не нужно");
    expect(markup).toContain("по учтённым операциям баланса хватит больше чем на 30 дней");
  });

  it("shows the error panel when the summary fails", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });

    const markup = renderPage();
    expect(markup).toContain("Не удалось загрузить кредиты OFAPI");
  });
});
