import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  useAdminOfapiCreditsSummary: vi.fn(),
  useAdminOfapiCreditsDaily: vi.fn(),
  useAdminOfapiCreditsLedger: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { OfapiCreditsPage } from "../apps/dashboard/src/pages/OfapiCreditsPage.tsx";

function renderPage() {
  return renderToStaticMarkup(createElement(OfapiCreditsPage));
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

  it("shows the disabled notice when the ledger flag is off", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture({ enabled: false }),
      isLoading: false,
      isError: false,
    });

    const markup = renderPage();
    expect(markup).toContain("Credit ledger disabled");
    expect(markup).toContain("OFAPI_CREDIT_LEDGER_ENABLED");
    expect(markup).toContain("Pending webhook estimates are unavailable");
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
  });

  it("renders ledger rows with page attribution", () => {
    queryMocks.useAdminOfapiCreditsSummary.mockReturnValue({
      data: summaryFixture(),
      isLoading: false,
      isError: false,
    });
    queryMocks.useAdminOfapiCreditsLedger.mockReturnValue({
      isLoading: false,
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
