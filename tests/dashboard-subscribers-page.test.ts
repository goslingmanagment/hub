import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const queryMocks = vi.hoisted(() => ({
  usePageSubscribers: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { SubscribersPage } from "../apps/dashboard/src/pages/SubscribersPage.tsx";

function renderPage() {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: ["/pages/lana/subscribers"] },
    createElement(
      Routes,
      undefined,
      createElement(Route, {
        path: "/pages/:pageLabel/subscribers",
        element: createElement(SubscribersPage),
      }),
    ),
  ));
}

// Review finding (P3): the "All" chip and the "{n} total" header were bound to
// the MAIN query's total, which the server computes under the active filter —
// selecting "Expiring ≤7d" made "All" read as the expiring count. Both must
// come from a dedicated unfiltered {limit: 1} count query, like the other
// three chips (which also deliberately ignore the search box: chips mean
// "population per category", search only narrows the table).
describe("SubscribersPage", () => {
  beforeEach(() => {
    queryMocks.usePageSubscribers.mockReset();
    queryMocks.usePageSubscribers.mockImplementation(
      (_pageLabel: string, params: Record<string, unknown>) => {
        if (params.limit === 1) {
          if (params.expiringWithinDays === 7) return { data: { total: 12 }, isLoading: false, isError: false };
          if (params.startedWithinHours === 24) return { data: { total: 3 }, isLoading: false, isError: false };
          if (params.autoRenew === false) return { data: { total: 7 }, isLoading: false, isError: false };
          // The unfiltered population count.
          return { data: { total: 500 }, isLoading: false, isError: false };
        }
        // The main table query — simulates a server response for a narrowed
        // view (filter/search active): total here is the FILTERED match count.
        return {
          data: {
            page: { platform: "fansly" },
            items: [],
            total: 12,
          },
          isLoading: false,
          isError: false,
        };
      },
    );
  });

  it("binds the All chip and the header total to the unfiltered count, not the filtered query", () => {
    const html = renderPage();

    // Header shows the page population, not the current result-set size.
    expect(html).toContain("500 total");
    expect(html).not.toContain("12 total");
    // Each chip carries its own population count.
    expect(html).toMatch(/>All<span[^>]*>500<\/span>/);
    expect(html).toMatch(/>Expiring ≤7d<span[^>]*>12<\/span>/);
    expect(html).toMatch(/>New 24h<span[^>]*>3<\/span>/);
    expect(html).toMatch(/>Auto-renew Off<span[^>]*>7<\/span>/);
  });
});
