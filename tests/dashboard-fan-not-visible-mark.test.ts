// Arena "vanished chat" R6: a payer whose page's own Fansly account lookup did
// not return him carries a small mark in that page's spender lists; a fan with
// a returned answer, no answer, or a server that omits the field shows as before.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import type { PageSpenderAutoListDetailResponse, SpenderListResponse } from "@agency_hub_core/contracts";

const mocks = vi.hoisted(() => ({
  queries: {
    useSpenders: vi.fn(),
    useSpenderBatch: vi.fn(),
    usePageSpenderAutoList: vi.fn(),
  },
  store: { period: "all", topSupportersPeriod: "all" },
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => mocks.queries);
vi.mock("@/stores/spenderPeriodStore", () => ({
  useSpenderPeriodStore: (selector?: (state: typeof mocks.store) => unknown) => selector ? selector(mocks.store) : mocks.store,
}));

import { describeFanNotVisible } from "../apps/dashboard/src/components/shared/FanNotVisibleMark.tsx";
import { PageSpendersSection } from "../apps/dashboard/src/pages/PageDetailPage.tsx";
import { SpenderAutoListPage } from "../apps/dashboard/src/pages/SpenderAutoListPage.tsx";
import { TopSupportersPage } from "../apps/dashboard/src/pages/TopSupportersPage.tsx";

const MISS_AT = "2026-10-06T09:50:00.000Z";
const page = { id: 1, label: "lora-1", platform: "fansly" as const, modelSlug: "lora", modelName: "Lora" };
const read = (data: unknown) => ({ data, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() });

/** Three payers: one this page cannot see, one it sees, one from a server
 *  that does not send the field yet. */
const FANS = [
  { platformUserId: "fan-hidden", username: "festerpenis", accountLookupMissAt: MISS_AT },
  { platformUserId: "fan-seen", username: "seenbuyer", accountLookupMissAt: null },
  { platformUserId: "fan-old-server", username: "oldserver" },
] as const;

function fanOf(platformUserId: string, username: string) {
  return { platform: "fansly" as const, platformUserId, username, displayName: null, createdAtExternal: null, pageAlias: null };
}

function spenderItem(input: (typeof FANS)[number]): SpenderListResponse["items"][number] {
  return {
    fan: fanOf(input.platformUserId, input.username),
    metrics: {
      window: null,
      lifetime: { scopeGrossAmountMills: 40_000, scopeCreatorNetAmountMills: 32_000, platformGrossAmountMills: 40_000, platformCreatorNetAmountMills: 32_000 },
      comparison: null,
    },
    lifetimeLastTransactionAt: "2026-10-01T12:00:00.000Z",
    lastFanMessageAt: null,
    conversation: {
      platformConversationId: null,
      unreadCount: 0,
      lastMessageAt: null,
      lastFanMessageAt: null,
      lastModelMessageAt: null,
      lastMessagePreview: null,
      storedMessageCount: 0,
      messageCoverageStatus: "complete",
      messageBackfillComplete: true,
    },
    lastTransaction: null,
    retentionStatus: "active",
    ...("accountLookupMissAt" in input ? { accountLookupMissAt: input.accountLookupMissAt } : {}),
  };
}

function spenderList(): SpenderListResponse {
  return {
    scope: { kind: "page", platform: "fansly", pageCount: 1, page, model: null },
    period: { timeZone: "UTC", fromBusinessDate: null, toBusinessDateInclusive: null, asOf: "2026-10-09T00:00:00.000Z" },
    diagnostics: {
      totalGrossAmountMills: 0,
      totalCreatorNetAmountMills: 0,
      attributedGrossAmountMills: 0,
      attributedCreatorNetAmountMills: 0,
      unattributedGrossAmountMills: 0,
      unattributedCreatorNetAmountMills: 0,
    },
    items: FANS.map(spenderItem),
    limit: 50,
    offset: 0,
    total: FANS.length,
  };
}

function autoList(): PageSpenderAutoListDetailResponse {
  return {
    page,
    currency: "USD",
    metric: "lifetimeGrossAmountMills",
    period: { timeZone: "UTC", fromBusinessDate: null, toBusinessDateInclusive: null, asOf: null },
    bucket: { key: "25-plus", label: "$25+", minAmountMills: 25_000, maxAmountMillsExclusive: null, entryCount: FANS.length },
    items: FANS.map((input) => ({
      fan: fanOf(input.platformUserId, input.username),
      isFollower: true,
      isSubscriber: false,
      subscriptionStatus: "never" as const,
      subscriptionExpiresAt: null,
      lastSubscriptionEndedAt: null,
      grossAmountMills: 40_000,
      creatorNetAmountMills: 32_000,
      lifetimeGrossAmountMills: 40_000,
      lifetimeCreatorNetAmountMills: 32_000,
      lastTransactionAt: null,
      ...("accountLookupMissAt" in input ? { accountLookupMissAt: input.accountLookupMissAt } : {}),
    })),
    limit: 50,
    offset: 0,
    total: FANS.length,
  };
}

function renderRoute(component: () => ReturnType<typeof createElement> | null, route: string, url: string) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] },
    createElement(Routes, undefined, createElement(Route, { path: route, element: createElement(component) }))));
}

/** The body row of each fan, keyed by username. */
function rowsByFan(html: string) {
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  const rows = body.split("<tr").slice(1);
  return new Map(FANS.map((fan) => {
    const matching = rows.filter((row) => row.includes(`>${fan.username}<`));
    expect(matching, fan.username).toHaveLength(1);
    return [fan.username, matching[0]!];
  }));
}

function expectMarkOnlyOnHiddenFan(html: string) {
  const rows = rowsByFan(html);
  expect(rows.get("festerpenis")).toContain("Not visible");
  expect(rows.get("seenbuyer")).not.toContain("Not visible");
  expect(rows.get("oldserver")).not.toContain("Not visible");
  expect(html.split("Not visible")).toHaveLength(2);
}

describe("the page's 'not visible' mark on its spender lists", () => {
  beforeEach(() => {
    mocks.queries.useSpenders.mockReset();
    mocks.queries.useSpenderBatch.mockReset().mockReturnValue({ data: undefined });
    mocks.queries.usePageSpenderAutoList.mockReset();
  });

  it("marks only the payer this page cannot see in Top Supporters", () => {
    mocks.queries.useSpenders.mockReturnValue(read(spenderList()));
    const html = renderRoute(TopSupportersPage, "/pages/:pageLabel/top-supporters", "/pages/lora-1/top-supporters");
    expectMarkOnlyOnHiddenFan(html);
    // Listing and totals are untouched: every payer stays, the footer sums all three.
    expect(html).toContain("3 total");
    expect(html).toContain("3 visible of 3");
  });

  it("marks only the payer this page cannot see in the page's Spenders tab", () => {
    const html = renderToStaticMarkup(createElement(PageSpendersSection, {
      spenders: spenderList(),
      spenderPeriod: "lifetime",
      spendersOffset: 0,
      onPageChange: () => {},
      onOpenFanProfile: () => {},
    }));
    expectMarkOnlyOnHiddenFan(html);
  });

  it("marks only the payer this page cannot see in a spender auto-list", () => {
    mocks.queries.usePageSpenderAutoList.mockReturnValue(read(autoList()));
    const html = renderRoute(SpenderAutoListPage, "/pages/:pageLabel/auto-lists/:bucketKey", "/pages/lora-1/auto-lists/25-plus");
    expectMarkOnlyOnHiddenFan(html);
    expect(html).toContain("3 entries");
  });

  it("is reachable from the keyboard and says 'probably' with the answer's date", () => {
    mocks.queries.useSpenders.mockReturnValue(read(spenderList()));
    const html = renderRoute(TopSupportersPage, "/pages/:pageLabel/top-supporters", "/pages/lora-1/top-supporters");
    const markRow = rowsByFan(html).get("festerpenis")!;
    expect(markRow).toMatch(/tabindex="0"[^>]*>(?:(?!<\/span>).)*Not visible/s);

    const copy = describeFanNotVisible(MISS_AT);
    expect(copy).toContain("This page can't see the fan's account");
    expect(copy).toContain("probably blocked the page or deleted the account");
    expect(copy).toContain("Oct 6");
  });
});
