import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OverviewResponse } from "@agency_hub_core/contracts";

import {
  MemoryRouter,
  Route,
  Routes,
} from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { DashboardShellProvider } from "../apps/dashboard/src/components/layout/DashboardShellContext.tsx";

const queryMocks = vi.hoisted(() => ({
  useAdminConnections: vi.fn(),
  useAuthMe: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { OwnerRoute } from "../apps/dashboard/src/components/layout/OwnerRoute.tsx";
import { Sidebar } from "../apps/dashboard/src/components/layout/Sidebar.tsx";
import {
  analyticsRange,
  buildAnalyticsRoute,
  resolveAnalyticsRange,
} from "../apps/dashboard/src/lib/navigation.ts";

/**
 * WP-S1 shell wiring: the Analytics page is reachable by an owner, invisible and
 * unreachable to anyone else.
 *
 * This is a NAVIGATION guard, not the real one. The real one is the eight route
 * declarations — `owner-session` + page scope, enforced by the API middleware
 * and pinned in `tests/contracts-auth-declarations.test.ts`. A dashboard that
 * forgot this guard would show a team lead an empty page of 403s; a dashboard
 * that had ONLY this guard would be defending nothing at all.
 */

type DashboardShellValue = ComponentProps<typeof DashboardShellProvider>["value"];
type PageItem = OverviewResponse["pages"][number];

function buildSyncUx() {
  return {
    state: "healthy" as const,
    label: "Up to date",
    headline: "Up to date",
    detail: null,
    progressLabel: null,
    nextRetryAt: null,
    updatedAt: "2026-08-20T12:00:00.000Z",
    requiresAction: false,
  };
}

function buildPage(overrides: Partial<PageItem> = {}): PageItem {
  return {
    id: 1,
    label: "lora-1",
    platform: "fansly",
    modelSlug: "lora",
    modelName: "Lora",
    username: "lora",
    subscriberCount: { value: 10, available: true },
    followerCount: { value: 100, available: true },
    revenueTodayMills: 0,
    revenue7dMills: 0,
    revenue30dMills: 0,
    newSubscribersToday: 0,
    newFollowersToday: 0,
    connectionStatus: "connected",
    lastLightSyncAt: null,
    lastFollowerSyncAt: null,
    lastSyncError: null,
    syncUx: buildSyncUx(),
    ...overrides,
  } as PageItem;
}

function renderWithShell(
  element: ReturnType<typeof createElement>,
  initialEntries: string[] = ["/"],
) {
  const pages = [buildPage()];
  const shellValue: DashboardShellValue = {
    pageCatalogState: "ready",
    pageCatalogError: null,
    pages,
    findPageByLabel: (pageLabel) => pages.find((page) => page.label === pageLabel) ?? null,
  };
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries },
    createElement(DashboardShellProvider, { value: shellValue, children: element }),
  ));
}

function renderAnalyticsRoute() {
  return renderWithShell(
    createElement(
      Routes,
      null,
      createElement(Route, {
        path: "/",
        element: createElement("div", null, "OVERVIEW"),
      }),
      createElement(Route, {
        path: "/analytics",
        element: createElement(
          OwnerRoute,
          { children: createElement("div", null, "ANALYTICS-PAGE") },
        ),
      }),
    ),
    ["/analytics"],
  );
}

describe("WP-S1 Analytics: the route is owner-only", () => {
  beforeEach(() => {
    queryMocks.useAdminConnections.mockReset();
    queryMocks.useAuthMe.mockReset();
    queryMocks.useAdminConnections.mockReturnValue({ data: [] });
  });

  it("renders for an owner session", () => {
    queryMocks.useAuthMe.mockReturnValue({
      data: { user: { username: "owner", role: "owner" } },
      isLoading: false,
    });
    expect(renderAnalyticsRoute()).toContain("ANALYTICS-PAGE");
  });

  it("does NOT render for a team lead — the guard redirects instead", () => {
    queryMocks.useAuthMe.mockReturnValue({
      data: { user: { username: "lead", role: "team_lead" } },
      isLoading: false,
    });
    const markup = renderAnalyticsRoute();
    expect(markup).not.toContain("ANALYTICS-PAGE");
  });

  it("does NOT render for a chatter either", () => {
    queryMocks.useAuthMe.mockReturnValue({
      data: { user: { username: "anton", role: "chatter" } },
      isLoading: false,
    });
    expect(renderAnalyticsRoute()).not.toContain("ANALYTICS-PAGE");
  });

  it("shows a loading state rather than the page while the session resolves", () => {
    // The failure this catches is a guard that renders children first and
    // redirects on the next tick — a flash of an owner-only page.
    queryMocks.useAuthMe.mockReturnValue({ data: undefined, isLoading: true });
    expect(renderAnalyticsRoute()).not.toContain("ANALYTICS-PAGE");
  });
});

describe("WP-S1 Analytics: the sidebar entry", () => {
  beforeEach(() => {
    queryMocks.useAdminConnections.mockReset();
    queryMocks.useAuthMe.mockReset();
    queryMocks.useAdminConnections.mockReturnValue({ data: [] });
  });

  it("offers Analytics to an owner", () => {
    const markup = renderWithShell(
      createElement(Sidebar, { user: { username: "owner", role: "owner" } }),
    );
    expect(markup).toContain(">Analytics<");
    expect(markup).toContain("/analytics");
  });

  it("hides the whole owner block — Analytics with it — from a team lead", () => {
    const markup = renderWithShell(
      createElement(Sidebar, { user: { username: "lead", role: "team_lead" } }),
    );
    expect(markup).not.toContain(">Analytics<");
  });

  it("carries the Fansly page already in view into the link", () => {
    const markup = renderWithShell(
      createElement(Sidebar, { user: { username: "owner", role: "owner" } }),
      ["/pages/lora-1"],
    );
    expect(markup).toContain("/analytics?page=lora-1");
  });
});

describe("WP-S1 Analytics: range presets", () => {
  it("defaults to 30d, which is the ONLY range the Suggestions footnote is true of", () => {
    expect(resolveAnalyticsRange(null)).toBe("30d");
    expect(resolveAnalyticsRange("nonsense")).toBe("30d");
    expect(resolveAnalyticsRange("7d")).toBe("7d");
    expect(resolveAnalyticsRange("90d")).toBe("90d");
  });

  it("builds `[from, to)` as RFC 3339 instants with an explicit offset", () => {
    const now = new Date("2026-08-20T12:00:00.000Z");
    const window = analyticsRange("30d", now);
    expect(window.to).toBe("2026-08-20T12:00:00.000Z");
    expect(window.from).toBe("2026-07-21T12:00:00.000Z");
    // Both bounds required, and both offset-bearing: the serving routes refuse
    // anything else rather than substituting a silent default window.
    expect(window.from.endsWith("Z")).toBe(true);
  });

  it("truncates `to` to the minute so a remount reuses the cached window", () => {
    // The seven Analytics queries key on `window.from`/`window.to`. A
    // millisecond-precise `now` gave every remount seven brand-new keys and
    // therefore seven refetches, `staleTime` notwithstanding.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-20T12:34:07.321Z"));
      const first = analyticsRange("30d");

      vi.setSystemTime(new Date("2026-08-20T12:34:59.999Z"));
      const remountSameMinute = analyticsRange("30d");
      expect(remountSameMinute).toEqual(first);
      expect(remountSameMinute.to).toBe("2026-08-20T12:34:00.000Z");
      expect(remountSameMinute.from).toBe("2026-07-21T12:34:00.000Z");

      // Coarse, not frozen: the window still advances. Keying by the PRESET
      // alone would pin it for as long as the tab stayed open.
      vi.setSystemTime(new Date("2026-08-20T12:35:00.000Z"));
      const nextMinute = analyticsRange("30d");
      expect(nextMinute.to).toBe("2026-08-20T12:35:00.000Z");
      expect(nextMinute).not.toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("truncates an explicitly passed `now` the same way", () => {
    expect(analyticsRange("7d", new Date("2026-08-20T12:34:07.321Z"))).toEqual({
      from: "2026-08-13T12:34:00.000Z",
      to: "2026-08-20T12:34:00.000Z",
    });
  });

  it("builds deep links that survive a page label with a slash", () => {
    expect(buildAnalyticsRoute()).toBe("/analytics");
    expect(buildAnalyticsRoute("lora-1")).toBe("/analytics?page=lora-1");
    expect(buildAnalyticsRoute("lora/of", "7d")).toBe("/analytics?page=lora%2Fof&range=7d");
  });
});
