import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  useAdminDbStats: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { DbStatsPage } from "../apps/dashboard/src/pages/dev/DbStatsPage.tsx";

function renderPage() {
  return renderToStaticMarkup(createElement(DbStatsPage));
}

describe("DbStatsPage", () => {
  beforeEach(() => {
    queryMocks.useAdminDbStats.mockReset();
  });

  it("labels the short migration hash column accurately", () => {
    queryMocks.useAdminDbStats.mockReturnValue({
      data: {
        tables: [],
        migrations: [{
          id: 24,
          hash: "1234567890abcdef1234567890abcdef",
          createdAt: "2026-03-22T12:00:00.000Z",
        }],
      },
      isLoading: false,
    });

    const html = renderPage();

    expect(html).toContain("Hash Prefix");
    expect(html).not.toContain(">Name<");
    expect(html).toContain("1234567890abcdef");
    expect(html).toContain("1234567890abcdef1234567890abcdef");
  });
});
