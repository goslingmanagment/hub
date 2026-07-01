import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  useAdminOfapiCreditsSummary: vi.fn(),
  useAdminOfapiCreditsDaily: vi.fn(),
  useAdminOfapiCreditsLedger: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { OfapiCreditsPage } from "../apps/dashboard/src/pages/OfapiCreditsPage.tsx";

// The page renders <Link> (deep-links to Settings), so it needs a Router context.
function renderPage() {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(OfapiCreditsPage)),
  );
}

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
    queryMocks.useAdminOfapiCreditsDaily.mockReturnValue({ data: emptyDaily, isLoading: false });
    queryMocks.useAdminOfapiCreditsLedger.mockReturnValue({
      data: { total: 0, rows: [] },
      isLoading: false,
    });
  });

  it("renders the summary cards and ops strip", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain("OFAPI Credits");
    expect(markup).toContain("23,950 cr");
    expect(markup).toContain("137 cr");
    expect(markup).toContain("dm 84/500");
    expect(markup).toContain("~31 days left");
    expect(markup).toContain("floor 500 OK");
    expect(markup).toContain("accrual posted for 2026-06-11");
    expect(markup).toContain("drift 0");
    expect(markup).not.toContain("Credit ledger disabled");
    // A healthy page raises no floor/incident alarm banner.
    expect(markup).not.toContain('role="alert"');
  });

  it("renders the pending current-day webhook estimate when present", () => {
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
    expect(markup).toContain("pending today 45 cr from");
    expect(markup).toContain("4,464 events");
  });

  it("shows the disabled notice pointing at Settings > Configuration", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({ enabled: false }),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain("Credit ledger disabled");
    expect(markup).toContain("Settings → Configuration");
    expect(markup).toContain("Open Configuration");
    expect(markup).toContain("config-ofapiCreditLedgerEnabled");
    // No longer instructs a raw env-var edit.
    expect(markup).not.toContain("OFAPI_CREDIT_LEDGER_ENABLED");
    // Ledger-derived sections are hidden with the flag off.
    expect(markup).not.toContain("Daily spend by source");
    expect(markup).not.toContain("Breakdown");
  });

  it("renders parked budgets and open incidents in the ops strip", () => {
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
    expect(markup).toContain("dm parked");
    expect(markup).toContain("incidents: ofapi_burn_rate");
    // Open incidents raise the top alarm banner.
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Open incidents: ofapi_burn_rate");
  });

  it("raises a floor-blocked alarm banner and reddens a short runway", () => {
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
    expect(markup).toContain("Balance floor blocked");
    expect(markup).toContain("floor 500 BLOCKED");
    // A sub-3-day runway (and the blocked hint) use the danger tone.
    expect(markup).toContain("text-red-700");
  });

  it("renders ledger rows with page attribution and an accessible expander", () => {
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
    expect(markup).toContain("ofapi_chats");
    expect(markup).toContain("lora-of");
    expect(markup).toContain("2026-06-12 10:30 UTC");
    // C3: the expander is a real button, not a bare clickable row.
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand ledger row details"');
    expect(markup).toContain("aria-controls=");
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

  it("deep-links budgets, floor, and burn alert to Settings > Configuration", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({
        budgets: [
          { stream: "dm", spentToday: 84, dailyCeiling: 500, state: "ok", retryAt: null },
          { stream: "audience", spentToday: 12, dailyCeiling: 300, state: "ok", retryAt: null },
        ],
      }),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain("config-ofapiDmDailyCreditBudget");
    expect(markup).toContain("config-ofapiAudienceDailyCreditBudget");
    expect(markup).toContain("config-ofapiCreditFloor");
    expect(markup).toContain("config-ofapiBurnAlertCreditsPerHour");
  });

  it("shows scoped errors for charts, breakdown, and ledger instead of empty data", () => {
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
    expect(markup).toContain("Failed to load spend charts");
    expect(markup).toContain("Failed to load breakdown");
    expect(markup).toContain("Failed to load ledger");
    expect(markup).toContain("Retry");
    // A failed ledger fetch must not read as an empty result.
    expect(markup).not.toContain("No ledger rows");
  });

  it("shows the error panel when the summary fails", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });

    const markup = renderPage();
    expect(markup).toContain("Failed to load OFAPI credits");
  });
});
