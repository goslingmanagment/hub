import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  useAdminChatterUsage: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { UsagePage } from "../apps/dashboard/src/pages/UsagePage.tsx";

function renderPage() {
  return renderToStaticMarkup(createElement(UsagePage));
}

describe("UsagePage", () => {
  beforeEach(() => {
    queryMocks.useAdminChatterUsage.mockReset();
  });

  it("hydrates the initial date inputs from the server-provided range and shows warning rows", () => {
    queryMocks.useAdminChatterUsage.mockReturnValue({
      data: {
        range: {
          from: "2026-03-29",
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
          regenerateRatePct: 33.33,
          warning: true,
        }],
      },
      isLoading: false,
      isError: false,
    });

    const html = renderPage();

    expect(html).toContain("value=\"2026-03-29\"");
    expect(html).toContain("value=\"2026-04-04\"");
    expect(html).toContain("Fast Reply (66.7%)");
    expect(html).toContain("33.3%");
    expect(html).toContain(">High<");
  });
});
