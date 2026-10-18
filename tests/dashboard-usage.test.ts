import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  useAdminChatterUsage: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

const accountMocks = vi.hoisted(() => ({
  useAdminAiAccounts: vi.fn(),
  useAdminUpdateAiAccount: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock("../apps/dashboard/src/api/adminAiAccounts.ts", () => accountMocks);

import { UsagePage } from "../apps/dashboard/src/pages/UsagePage.tsx";

function renderPage() {
  return renderToStaticMarkup(createElement(UsagePage));
}

const zeroCost = {
  microUsd: 0,
  approximate: false,
};

const zeroGateway = {
  requestCount: 0,
  completedCount: 0,
  failedCount: 0,
  cancelledCount: 0,
  quotaDeniedCount: 0,
  openReservationCount: 0,
  providerBreakdown: [],
};

describe("UsagePage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    queryMocks.useAdminChatterUsage.mockReset();
    accountMocks.useAdminAiAccounts.mockReset();
    accountMocks.useAdminAiAccounts.mockReturnValue({ data: undefined, isLoading: true, isError: false });
  });

  it("shows the Anthropic accounts: which one is spent, its spend and the estimated balance", () => {
    queryMocks.useAdminChatterUsage.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    accountMocks.useAdminAiAccounts.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        generatedAt: "2026-10-18T03:40:00.000Z",
        dailyBurnMicroUsd: 36_500_000,
        unattributed30dMicroUsd: 0,
        accounts: [
          {
            id: 1, label: "main", priority: 1, enabled: true, status: "exhausted",
            statusReason: "Anthropic refused for credit (HTTP 400)", statusChangedAt: "2026-10-18T01:40:00.000Z",
            configured: true, serving: false, keyHint: "RQAA", lastUsedAt: "2026-10-18T01:40:00.000Z",
            spent: { last24hMicroUsd: 21_400_000, last7dMicroUsd: 198_300_000, last30dMicroUsd: 290_100_000 },
            requests: { last24h: 812, last30d: 17_900 }, balance: null,
          },
          {
            id: 2, label: "bukake", priority: 2, enabled: true, status: "active", statusReason: null,
            statusChangedAt: null, configured: true, serving: true, keyHint: "u6QA", lastUsedAt: "2026-10-18T03:39:00.000Z",
            spent: { last24hMicroUsd: 16_250_000, last7dMicroUsd: 16_250_000, last30dMicroUsd: 16_250_000 },
            requests: { last24h: 640, last30d: 640 },
            balance: {
              readMicroUsd: 250_000_000, readAt: "2026-10-17T21:40:00.000Z", spentSinceMicroUsd: 16_250_000,
              estimatedMicroUsd: 233_750_000, daysLeft: 6.4,
            },
          },
        ],
      },
    });

    const html = renderPage();

    expect(html).toContain("Аккаунты Anthropic");
    expect(html).toContain("кончился кредит");
    expect(html).toContain("тратится сейчас");
    expect(html).toContain("$290.10");
    expect(html).toContain("≈ $233.75");
    expect(html).toContain("хватит на ~6 дней");
    expect(html).toContain("Указать остаток");
    expect(html).not.toContain("sk-ant");
  });

  it("renders pivot table with feature columns and warning badge for high regen rate", () => {
    queryMocks.useAdminChatterUsage.mockReturnValue({
      data: {
        range: {
          from: "2026-04-04",
          to: "2026-04-04",
          timeZone: "Europe/Moscow",
        },
        rows: [{
          userId: 7,
          username: "anton",
          totalGenerations: 12,
          tokenCounts: {
            input: 1200,
            output: 800,
            cacheWrite: 100,
            cacheRead: 50,
            cacheTotal: 150,
          },
          cost: {
            microUsd: 2_340_000,
            approximate: true,
          },
          gateway: {
            requestCount: 2,
            completedCount: 2,
            failedCount: 0,
            cancelledCount: 0,
            quotaDeniedCount: 0,
            openReservationCount: 0,
            providerBreakdown: [{
              provider: "anthropic",
              requestCount: 2,
              costMicroUsd: 2_340_000,
            }],
          },
          topFeature: {
            feature: "fast-reply",
            requestCount: 8,
            sharePct: 66.67,
          },
          featureBreakdown: [
            {
              feature: "fast-reply",
              requestCount: 8,
              sharePct: 66.67,
              tokenCounts: {
                input: 900,
                output: 700,
                cacheWrite: 80,
                cacheRead: 40,
                cacheTotal: 120,
              },
              costMicroUsd: 2_000_000,
              costApproximate: true,
              regenerateRatePct: 25,
            },
            {
              feature: "scan",
              requestCount: 4,
              sharePct: 33.33,
              tokenCounts: {
                input: 300,
                output: 100,
                cacheWrite: 20,
                cacheRead: 10,
                cacheTotal: 30,
              },
              costMicroUsd: 340_000,
              costApproximate: true,
              regenerateRatePct: 50,
            },
          ],
          regenerateRatePct: 33.33,
          warning: true,
        }],
      },
      isLoading: false,
      isError: false,
    });

    const html = renderPage();

    // five columns: who, how many, how much, regenerations, the top feature
    for (const column of [">Сотрудник<", ">Запросов<", ">Стоимость<", ">Перегенерации<", ">Чаще всего<"]) {
      expect(html).toContain(column);
    }
    // the top feature in the cabinet's Russian name, with its count and share
    expect(html).toContain("Быстрый ответ");
    expect(html).toContain("8 · 66.7%");

    // chatter name and total
    expect(html).toContain("anton");
    expect(html).toContain(">12<");
    expect(html).toContain("~$2.34");

    // the per-feature split lives in the person's expandable details
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('id="usage-details-7"');
    expect(html).toContain("8 запросов");
    expect(html).toContain("Скан");
    expect(html).toContain("4 запроса");

    // regen rate + warning
    expect(html).toContain("33.3%");
    expect(html).toContain(">много</");
  });

  it("hides chatters with zero activity", () => {
    queryMocks.useAdminChatterUsage.mockReturnValue({
      data: {
        range: { from: "2026-04-04", to: "2026-04-04", timeZone: "Europe/Moscow" },
        rows: [
          {
            userId: 1,
            username: "active",
            totalGenerations: 5,
            tokenCounts: { input: 100, output: 50, cacheWrite: 10, cacheRead: 5, cacheTotal: 15 },
            cost: zeroCost,
            gateway: zeroGateway,
            topFeature: { feature: "fast-reply", requestCount: 5, sharePct: 100 },
            featureBreakdown: [
              {
                feature: "fast-reply",
                requestCount: 5,
                sharePct: 100,
                tokenCounts: { input: 100, output: 50, cacheWrite: 10, cacheRead: 5, cacheTotal: 15 },
                costMicroUsd: 0,
                costApproximate: false,
                regenerateRatePct: 0,
              },
            ],
            regenerateRatePct: 0,
            warning: false,
          },
          {
            userId: 2,
            username: "idle",
            totalGenerations: 0,
            tokenCounts: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cacheTotal: 0 },
            cost: zeroCost,
            gateway: zeroGateway,
            topFeature: null,
            featureBreakdown: [],
            regenerateRatePct: 0,
            warning: false,
          },
        ],
      },
      isLoading: false,
      isError: false,
    });

    const html = renderPage();

    expect(html).toContain("active");
    expect(html).not.toContain("idle");
  });

  it("uses the Moscow business date when choosing the default range", () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "UTC";

    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-04-04T21:30:00.000Z"));
      queryMocks.useAdminChatterUsage.mockReturnValue({
        data: {
          range: { from: "2026-04-05", to: "2026-04-05", timeZone: "Europe/Moscow" },
          rows: [],
        },
        isLoading: false,
        isError: false,
      });

      renderPage();

      expect(queryMocks.useAdminChatterUsage).toHaveBeenCalledWith({
        from: "2026-04-05",
        to: "2026-04-05",
      });
    } finally {
      if (previousTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTz;
      }
    }
  });
});
