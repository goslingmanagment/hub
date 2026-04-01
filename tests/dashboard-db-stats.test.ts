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

  it("renders migration names from schema_migrations", () => {
    queryMocks.useAdminDbStats.mockReturnValue({
      data: {
        tables: [],
        migrations: [{
          name: "20260322_add_sync_rollups.sql",
          appliedAt: "2026-03-22T12:00:00.000Z",
        }],
      },
      isLoading: false,
    });

    const html = renderPage();

    expect(html).toContain("Migration");
    expect(html).toContain("Applied");
    expect(html).toContain("20260322_add_sync_rollups.sql");
  });
});
