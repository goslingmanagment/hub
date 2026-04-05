import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  useAdminChatterUsage: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { UsagePage } from "../apps/dashboard/src/pages/UsagePage.tsx";

function renderPage() {
  return renderToStaticMarkup(createElement(UsagePage));
}

describe("UsagePage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    queryMocks.useAdminChatterUsage.mockReset();
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

    // pivot table shows feature columns
    expect(html).toContain(">Fast Reply<");
    expect(html).toContain(">Scan<");

    // chatter name and total
    expect(html).toContain("anton");
    expect(html).toContain(">12<");

    // feature request counts shown in cells
    expect(html).toContain(">8<");
    expect(html).toContain(">4<");

    // regen rate + warning
    expect(html).toContain("33.3%");
    expect(html).toContain(">!</");
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
            topFeature: { feature: "fast-reply", requestCount: 5, sharePct: 100 },
            featureBreakdown: [
              {
                feature: "fast-reply",
                requestCount: 5,
                sharePct: 100,
                tokenCounts: { input: 100, output: 50, cacheWrite: 10, cacheRead: 5, cacheTotal: 15 },
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
