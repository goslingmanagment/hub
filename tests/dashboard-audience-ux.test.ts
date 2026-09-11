import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import {
  audiencePeriod,
  buildAudienceFanNavigation,
  followerFilter,
  resolveAudienceBackTarget,
  updateAudienceSearch,
} from "../apps/dashboard/src/lib/audienceNavigation.ts";

const queryMocks = vi.hoisted(() => ({
  usePageFollowers: vi.fn(),
  usePageSpenderAutoList: vi.fn(),
  usePageDeletedFans: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);
vi.mock("@/stores/spenderPeriodStore", () => ({
  useSpenderPeriodStore: (selector: (state: { period: string }) => unknown) => selector({ period: "7d" }),
}));

import { FollowersPage } from "../apps/dashboard/src/pages/FollowersPage.tsx";
import { SpenderAutoListPage } from "../apps/dashboard/src/pages/SpenderAutoListPage.tsx";
import { DeletedFansPage } from "../apps/dashboard/src/pages/DeletedFansPage.tsx";

function renderPage(component: typeof FollowersPage, path: string, url: string) {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: [url] },
    createElement(Routes, undefined, createElement(Route, { path, element: createElement(component) })),
  ));
}

describe("audience navigation", () => {
  it("validates filters and periods and resets only list pagination when filtering", () => {
    expect(followerFilter("unmessaged")).toBe("unmessaged");
    expect(followerFilter("unknown")).toBe("all");
    expect(audiencePeriod("180d", "7d")).toBe("180d");
    expect(audiencePeriod("lifetime", "7d")).toBe("7d");
    const previous = new URLSearchParams("filter=active&offset=50&period=30d&backTo=%2F");
    const next = updateAudienceSearch(previous, { query: "ann", filter: null });
    expect(next.get("query")).toBe("ann");
    expect(next.has("offset")).toBe(false);
    expect(next.has("filter")).toBe(false);
    expect(next.get("period")).toBe("30d");
    expect(next.get("backTo")).toBe("/");
    expect(previous.get("offset")).toBe("50");
    expect(updateAudienceSearch(next, { offset: "50" }, false).get("query")).toBe("ann");
  });

  it("preserves the full source URL and source period even without router state", () => {
    const backTo = "/pages/lana/top-supporters?q=two+words&filter=cooling&offset=50&period=all";
    const navigation = buildAudienceFanNavigation("lana", "fansly", "fan/001", backTo, "buyer", "all");
    const url = new URL(navigation.to, "https://hub.invalid");
    expect(url.pathname).toBe("/pages/lana/fans/fansly/fan%2F001");
    expect(url.searchParams.get("period")).toBe("all");
    expect(resolveAudienceBackTarget(url.search, undefined, "lana")).toBe(backTo);
    expect(navigation.state.fanLabel).toBe("buyer");
  });

  it("freezes a list's fallback period before the fan screen can change the shared store", () => {
    const navigation = buildAudienceFanNavigation("lana", "fansly", "fan-001", "/pages/lana/spender-autolists/vip?offset=50", "buyer", "7d");
    const url = new URL(navigation.to, "https://hub.invalid");
    expect(resolveAudienceBackTarget(url.search, undefined, "lana")).toBe("/pages/lana/spender-autolists/vip?offset=50&period=7d");
  });

  it.each(["https://evil.invalid", "//evil.invalid", "/\\evil.invalid", "/%2f%2fevil.invalid"])("rejects unsafe return target %s", (backTo) => {
    expect(resolveAudienceBackTarget(`?backTo=${encodeURIComponent(backTo)}`, null, "lana")).toBe("/pages/lana");
    const navigation = buildAudienceFanNavigation("lana", "fansly", "fan-001", backTo);
    expect(new URL(navigation.to, "https://hub.invalid").searchParams.get("backTo")).toBe("/pages/lana");
  });
});

describe("audience list states", () => {
  beforeEach(() => {
    for (const mock of Object.values(queryMocks)) mock.mockReset();
  });

  it("reads follower filter/search/offset from a deep link and retains controls on failure", () => {
    queryMocks.usePageFollowers.mockReturnValue({ data: undefined, isError: true, refetch: vi.fn() });
    const html = renderPage(FollowersPage, "/pages/:pageLabel/followers", "/pages/lana/followers?filter=active&query=ann&offset=50");
    expect(queryMocks.usePageFollowers.mock.calls[0]![1]).toMatchObject({ query: "ann", offset: 50, activeWithinMinutes: 120 });
    expect(html).toContain("Не удалось загрузить фолловеров");
    expect(html).toContain('value="ann"');
    expect(html).toContain("Сбросить фильтры");
    expect(html).not.toContain("фолловеры не найдены");
  });

  it("keeps loading separate from a confirmed empty follower list", () => {
    queryMocks.usePageFollowers.mockReturnValue({ data: undefined, isError: false, refetch: vi.fn() });
    const html = renderPage(FollowersPage, "/pages/:pageLabel/followers", "/pages/lana/followers");
    expect(html).toContain("Загрузка фолловеров");
    expect(html).not.toContain("пока нет записей о фолловерах");
  });

  it("renders a follower as a real link with the exact return context and marks stale data", () => {
    queryMocks.usePageFollowers.mockReturnValue({
      data: {
        page: { platform: "fansly" }, total: 51,
        items: [{ platformUserId: "fan-001", username: "buyer", followedAt: "2026-01-01T00:00:00Z" }],
      },
      isError: true, refetch: vi.fn(),
    });
    const url = "/pages/lana/followers?query=buyer&offset=50";
    const html = renderPage(FollowersPage, "/pages/:pageLabel/followers", url);
    expect(html).toContain(`href="/pages/lana/fans/fansly/fan-001?backTo=${encodeURIComponent(url)}"`);
    expect(html).toContain("ранее полученные данные");
    expect(html).toContain("Неизвестно");
    expect(html).not.toContain("$0.00");
  });

  it("preserves negative recorded creator net amounts in follower rows", () => {
    queryMocks.usePageFollowers.mockReturnValue({
      data: { page: { platform: "fansly" }, total: 1, items: [{ platformUserId: "fan-001", username: "buyer", followedAt: "2026-01-01T00:00:00Z", totalSpentCents: -1250 }] },
      isError: false, refetch: vi.fn(),
    });
    const html = renderPage(FollowersPage, "/pages/:pageLabel/followers", "/pages/lana/followers");
    expect(html).toContain("Доход автора");
    expect(html).toContain("-$12.50");
    expect(html).not.toContain("$0.00");
  });

  it("restores auto-list scope from the URL and does not claim an empty list after a failure", () => {
    queryMocks.usePageSpenderAutoList.mockReturnValue({ data: undefined, isError: true, refetch: vi.fn() });
    const html = renderPage(SpenderAutoListPage, "/pages/:pageLabel/spender-autolists/:bucketKey", "/pages/lana/spender-autolists/vip?query=ann&followersOnly=true&offset=50&period=90d");
    expect(queryMocks.usePageSpenderAutoList.mock.calls[0]![2]).toMatchObject({ query: "ann", excludeNonFollowers: true, offset: 50, period: "90d" });
    expect(html).toContain("Не удалось загрузить список");
    expect(html).not.toContain("В этом списке пока нет фанов");
  });

  it("retains deleted-fan pagination and distinguishes a failed audit from no deleted accounts", () => {
    queryMocks.usePageDeletedFans.mockReturnValue({ data: undefined, isError: true, refetch: vi.fn() });
    const html = renderPage(DeletedFansPage, "/pages/:pageLabel/deleted-fans", "/pages/lana/deleted-fans?offset=50");
    expect(queryMocks.usePageDeletedFans.mock.calls[0]![1]).toEqual({ limit: 50, offset: 50 });
    expect(html).toContain("Не удалось загрузить удалённые аккаунты");
    expect(html).not.toContain("Удалённые аккаунты пока не обнаружены");
  });
});
