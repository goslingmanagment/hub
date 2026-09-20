import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import type { SpenderListResponse } from "@agency_hub_core/contracts";
import type * as Navigation from "../apps/dashboard/src/lib/navigation.ts";

const mocks = vi.hoisted(() => ({
  queries: Object.fromEntries([
    "useAuthMe", "useOverview", "usePageRevenue", "usePageSubscribers", "usePageTransactions",
    "useSpenders", "usePageSpenderAutoLists", "usePageFollowersDaily", "usePageSubscribersDaily",
    "usePageRevenueDaily", "usePageFollowers", "usePageSpenderAutoList", "usePageDeletedFans",
    "usePageFanDetail", "usePageFanProfile", "usePageFanProfileVersion", "usePageFanProfileVersions",
    "usePageFanTransactions", "useCreateFanNote", "useSpenderDetail", "useSpenderBatch",
  ].map((key) => [key, vi.fn()])),
  store: { period: "7d", topSupportersPeriod: "all" },
  fanNavigation: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => mocks.queries);
vi.mock("@/stores/periodStore", () => ({ usePeriodStore: () => ({ period: mocks.store.period }) }));
vi.mock("@/stores/spenderPeriodStore", () => ({
  useSpenderPeriodStore: (selector?: (state: typeof mocks.store) => unknown) => selector ? selector(mocks.store) : mocks.store,
}));
vi.mock("@/lib/navigation", async (original) => {
  const module = await original<typeof Navigation>();
  return { ...module, buildFanProfileNavigation: (...args: Parameters<typeof module.buildFanProfileNavigation>) => {
    mocks.fanNavigation(...args);
    return module.buildFanProfileNavigation(...args);
  } };
});
vi.mock("@/components/layout/DashboardShellContext", () => ({
  useDashboardShell: () => ({
    pageCatalogState: "ready",
    pageCatalogError: null,
    findPageByLabel: () => ({ id: 1, label: "lana", platform: "fansly", modelSlug: "lana", modelName: "Lana", username: "lana" }),
  }),
}));

import { FollowersPage } from "../apps/dashboard/src/pages/FollowersPage.tsx";
import { SpenderAutoListPage } from "../apps/dashboard/src/pages/SpenderAutoListPage.tsx";
import { DeletedFansPage } from "../apps/dashboard/src/pages/DeletedFansPage.tsx";
import { TopSupportersPage } from "../apps/dashboard/src/pages/TopSupportersPage.tsx";
import { FanProfilePage } from "../apps/dashboard/src/pages/FanProfilePage.tsx";
import { PageDetailPage } from "../apps/dashboard/src/pages/PageDetailPage.tsx";
import { ReadSection } from "../apps/dashboard/src/pages/daily/ReadSection.tsx";

const fan = { platform: "fansly", platformUserId: "fan-1", username: "buyer", displayName: "Buyer", pageAlias: null, createdAtExternal: null };
const page = { id: 1, label: "lana", platform: "fansly", modelSlug: "lana", modelName: "Lana" };
const read = (data: unknown, patch: Record<string, unknown> = {}) => ({ data, isLoading: data === undefined, isError: false, isFetching: false, refetch: vi.fn(), ...patch });
const failure = () => read(undefined, { isLoading: false, isError: true });

function renderPage(component: () => ReturnType<typeof createElement> | null, route: string, url: string) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] },
    createElement(Routes, undefined, createElement(Route, { path: route, element: createElement(component) }))));
}
function supporterItem(): SpenderListResponse["items"][number] {
  return {
    fan: { ...fan, platform: "fansly" },
    metrics: { window: null, lifetime: { scopeGrossAmountMills: 125000, scopeCreatorNetAmountMills: 100000, platformGrossAmountMills: 125000, platformCreatorNetAmountMills: 100000 }, comparison: null },
    lifetimeLastTransactionAt: null, lastFanMessageAt: null, lastTransaction: null, retentionStatus: "inactive",
    conversation: { platformConversationId: null, unreadCount: 0, lastMessageAt: null, lastFanMessageAt: null, lastModelMessageAt: null, lastMessagePreview: null, storedMessageCount: 0, messageCoverageStatus: "pending_backfill", messageBackfillComplete: false },
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks.queries)) mock.mockReset().mockReturnValue(read(undefined));
  mocks.fanNavigation.mockClear();
  mocks.store.period = "7d";
  mocks.store.topSupportersPeriod = "all";
  mocks.queries.useAuthMe!.mockReturnValue(read({ user: { role: "owner" } }));
  mocks.queries.useCreateFanNote!.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });
});

describe("daily-page independent reads", () => {
  it("does not render empty financial children until their own read succeeds", () => {
    const render = (query: ReturnType<typeof read>) => renderToStaticMarkup(createElement(ReadSection, { title: "Доход", query: query as never, children: "$0.00 · No transactions" }));
    expect(render(read(undefined))).not.toContain("$0.00");
    const failed = render(failure());
    expect(failed).toContain("Доход: не удалось загрузить");
    expect(failed).not.toContain("No transactions");
    const stale = render(read({ net: 0 }, { isError: true }));
    expect(stale).toContain("ранее полученные данные");
    expect(stale).toContain("$0.00");
  });

  it("keeps PageDetail money available when sync overview fails, without inventing empty audience panels", () => {
    mocks.queries.useOverview!.mockReturnValue(failure());
    mocks.queries.usePageRevenue!.mockReturnValue(read({ netEarningsMills: 123450, breakdown: [], comparison: null }));
    mocks.queries.usePageSubscribers!.mockReturnValue(failure());
    mocks.queries.usePageSpenderAutoLists!.mockReturnValue(failure());
    mocks.queries.usePageTransactions!.mockReturnValue(failure());
    const html = renderPage(PageDetailPage, "/pages/:pageLabel", "/pages/lana?period=30d&type=tip&txOffset=50");
    expect(html).toContain("$123.45");
    expect(html).toContain("Состояние сбора недоступно");
    expect(html).toContain("Подписчики: не удалось загрузить");
    expect(html).not.toContain("No subscribers found");
    expect(html).not.toContain("No transactions found");
    expect(mocks.queries.usePageRevenue).toHaveBeenCalledWith("lana", "30d", expect.objectContaining({ enabled: true }));
    expect(mocks.queries.usePageTransactions).toHaveBeenCalledWith("lana", expect.objectContaining({ type: "tip", offset: 50 }), expect.anything());
  });

  it("does not turn failed fan metrics, profile or history into zero spend and absence", () => {
    mocks.queries.usePageFanDetail!.mockReturnValue(read({ fan, page: { pageLabel: "lana", notes: [], isSubscriber: false, isFollower: true, subscriptionExpiresAt: null } }));
    mocks.queries.useSpenderDetail!.mockReturnValue(failure());
    mocks.queries.usePageFanProfile!.mockReturnValue(failure());
    mocks.queries.usePageFanTransactions!.mockReturnValue(failure());
    const html = renderPage(FanProfilePage, "/pages/:pageLabel/fans/:platform/:platformUserId", "/pages/lana/fans/fansly/fan-1?period=90d");
    expect(html).toContain("Доход от фана: не удалось загрузить");
    expect(html).toContain("Досье фана: не удалось загрузить");
    expect(html).toContain("История операций: не удалось загрузить");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("No profile available");
    expect(html).not.toContain("No transactions found");
    expect(mocks.queries.useSpenderDetail).toHaveBeenCalledWith("fansly", "fan-1", expect.objectContaining({ period: "90d" }));
  });

  it("shows a retryable TopSupporters failure instead of an endless skeleton", () => {
    mocks.queries.useSpenders!.mockReturnValue(failure());
    const html = renderPage(TopSupportersPage, "/pages/:pageLabel/top-supporters", "/pages/lana/top-supporters");
    expect(html).toContain("Top Supporters: не удалось загрузить");
    expect(html).toContain("Повторить");
    expect(html).not.toContain("animate-pulse");
  });

  it("preserves supporter totals but marks failed batch enrichment unavailable", () => {
    mocks.queries.useSpenders!.mockReturnValue(read({ scope: { page }, items: [supporterItem()], total: 1 }));
    mocks.queries.useSpenderBatch!.mockReturnValue(failure());
    const html = renderPage(TopSupportersPage, "/pages/:pageLabel/top-supporters", "/pages/lana/top-supporters");
    expect(html).toContain("$100.00");
    expect(html).toContain("Детали подписок и разбивка расходов");
    expect(html).toContain("Недоступно");
  });
});

describe("daily-page route context", () => {
  it("restores follower filter, search and offset from a bookmarked or returned URL", () => {
    mocks.queries.usePageFollowers!.mockReturnValue(read({ page, total: 51, items: [{ ...fan, followedAt: "2026-09-01T00:00:00Z", isSubscriber: false, totalSpentCents: 0, dm: { hasConversation: false }, presence: { status: "offline" } }] }));
    const url = "/pages/lana/followers?filter=unmessaged&query=buyer&offset=50&backTo=%2F%3Fperiod%3D30d";
    renderPage(FollowersPage, "/pages/:pageLabel/followers", url);
    expect(mocks.queries.usePageFollowers).toHaveBeenCalledWith("lana", expect.objectContaining({ dmStatus: "none", query: "buyer", offset: 50 }));
    expect(mocks.fanNavigation).toHaveBeenCalledWith("lana", "fansly", "fan-1", url, expect.any(String));
    mocks.queries.usePageFollowers!.mockClear();
    renderPage(FollowersPage, "/pages/:pageLabel/followers", "/pages/lana/followers?filter=active");
    expect(mocks.queries.usePageFollowers).toHaveBeenCalledWith("lana", expect.objectContaining({ activeWithinMinutes: 120, offset: 0 }));
    renderPage(FollowersPage, "/pages/:pageLabel/followers", url);
    expect(mocks.queries.usePageFollowers).toHaveBeenLastCalledWith("lana", expect.objectContaining({ query: "buyer", offset: 50 }));
  });

  it("carries auto-list period and complete return context into the fan profile", () => {
    mocks.queries.usePageSpenderAutoList!.mockReturnValue(read({ page, bucket: { label: "$100+" }, total: 51, items: [{ fan, grossAmountMills: 125000, creatorNetAmountMills: 100000, isFollower: true, subscriptionStatus: "never", lastTransactionAt: null }] }));
    const url = "/pages/lana/auto-lists/100?period=30d&query=buyer&followersOnly=true&offset=50";
    const html = renderPage(SpenderAutoListPage, "/pages/:pageLabel/auto-lists/:bucketKey", url);
    expect(mocks.queries.usePageSpenderAutoList).toHaveBeenCalledWith("lana", "100", expect.objectContaining({ period: "30d", query: "buyer", excludeNonFollowers: true, offset: 50 }), expect.anything());
    expect(mocks.fanNavigation).toHaveBeenCalledWith("lana", "fansly", "fan-1", url, expect.any(String));
    expect(html).toContain("fan-1?period=30d");
    expect(html).toContain("overflow-x-auto");
  });

  it("preserves TopSupporters paging and sorting on a return URL and rejects unsafe offsets", () => {
    mocks.queries.useSpenders!.mockReturnValue(read({ scope: { page }, items: [supporterItem()], total: 51 }));
    const url = "/pages/lana/top-supporters?period=all&filter=inactive&q=buyer&offset=50&sortBy=lastTransactionAt&dir=asc";
    renderPage(TopSupportersPage, "/pages/:pageLabel/top-supporters", url);
    expect(mocks.queries.useSpenders).toHaveBeenCalledWith(expect.objectContaining({ period: "lifetime", query: "buyer", retentionStatus: "inactive", offset: 50, sortBy: "lastTransactionAt", sortDir: "asc" }));
    expect(mocks.fanNavigation).toHaveBeenCalledWith("lana", "fansly", "fan-1", url, expect.any(String));
    renderPage(TopSupportersPage, "/pages/:pageLabel/top-supporters", "/pages/lana/top-supporters?offset=Infinity");
    expect(mocks.queries.useSpenders).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }));
  });

  it("retains deleted-fan paging across reloads and discloses a failed refresh", () => {
    mocks.queries.usePageDeletedFans!.mockReturnValue(read({ page, items: [], total: 0 }, { isError: true }));
    const html = renderPage(DeletedFansPage, "/pages/:pageLabel/deleted-fans", "/pages/lana/deleted-fans?offset=50");
    expect(mocks.queries.usePageDeletedFans).toHaveBeenCalledWith("lana", { limit: 50, offset: 50 }, expect.anything());
    expect(html).toContain("ранее полученные данные");
    expect(html).toContain("overflow-x-auto");
  });
});
