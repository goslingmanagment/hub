import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfLink, OfLinksResponse } from "@agency_hub_core/contracts";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { QueryClient, QueryClientProvider } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";

// «Ссылки OnlyFans» (traffic plan §2.7, PR 16): the screen on the link series
// API — fans by kind, net money, state, freshness, channel, both money
// figures, warnings; Smart Links hidden while unused; no short poll.

const mocks = vi.hoisted(() => ({ links: vi.fn(), marketing: vi.fn() }));
vi.mock("../apps/dashboard/src/api/ofLinks.ts", () => ({ useOfLinks: mocks.links }));
vi.mock("../apps/dashboard/src/api/ofapiMarketing.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOfapiMarketing: mocks.marketing,
  marketingActions: {},
}));
vi.mock("../apps/dashboard/src/api/ofapiCollection.ts", () => ({
  ofapiCollectionQueryOptions: () => ({ queryKey: ["admin", "ofapi-collection"], queryFn: () => new Promise(() => {}) }),
}));

import { effectivePickedLink, OfapiMarketing, smartLinksHaveData } from "../apps/dashboard/src/pages/OfapiMarketing.tsx";
import { marketingActionInFlight, marketingRefetchInterval, MARKETING_POLL_MS, type MarketingDashboard } from "../apps/dashboard/src/api/ofapiMarketing.ts";
import {
  filterLinks,
  hubMoneyView,
  linkStateView,
  linkTotals,
  pageWarnings,
  sortLinks,
  vendorMoneyView,
} from "../apps/dashboard/src/pages/marketing/ofLinksView.ts";

const GENERATED = "2026-10-09T13:00:00.000Z";
const noHub = {
  state: "no_data", reason: "not_computed", revenueBasis: "creator_net_after_platform_fee",
  attributionRule: "ofapi_subscription_period_equal_split.v1", floorAt: null, netMills: null,
  pendingMills: null, transactionCount: null, fanCount: null,
} as const;

function link(overrides: Partial<OfLink> = {}): OfLink {
  return {
    pageId: 9, linkKind: "trial", linkRef: "10802699", name: "reddit rsr_3", url: "https://onlyfans.com/x",
    linkCreatedAt: "2025-11-26T17:06:21.000Z", linkEndsAt: "2026-09-30T00:42:13.000Z", isFinished: true,
    state: "expired", trialDays: 180, tags: [], observedAt: "2026-10-09T03:45:30.000Z", businessDate: "2026-10-09",
    runRef: "620", inLatestRun: true, clicks: 11674, claims: 2939, subscribers: 0, spenders: 126,
    fans: 2939, fansMetric: "claims",
    vendorMoney: { revenueBasis: "creator_net_after_platform_fee", netMills: 13_483_440, chargebacksMills: 0, calculatedAt: "2026-10-06T06:08:18.000Z", isLoading: false, lastRecalculation: null },
    hubMoney: noHub,
    comparison: { state: null, flags: [], fromAt: null, toAt: null, vendorDeltaMills: null, hubNetMills: null, differenceMills: null },
    binding: {
      channelKey: "lora.reddit", channelTitle: "Reddit", validFrom: "2025-11-26T17:06:21.000Z", validTo: null,
      validFromBasis: "assumed_link_created", contractor: null,
    },
    ...overrides,
  };
}

const attempt = (status: "complete" | "failed" | "skipped", usable: boolean, reason: string | null = null, observedAt = "2026-10-09T12:46:03.000Z") => ({
  runRef: "1", observedAt, businessDate: "2026-10-09", windowAt: "2026-10-09T09:45:00.000Z", attempt: 4, status, reason, usable,
});

function snapshot(overrides: Partial<OfLinksResponse> = {}): OfLinksResponse {
  return {
    generatedAt: GENERATED, businessTimeZone: "Europe/Moscow", revenueBasis: "creator_net_after_platform_fee",
    seriesFloorAt: "2026-07-22T12:17:47.000Z", staleAfterHours: 15,
    pages: [{
      pageId: 9, pageLabel: "lora-vip-of", ofapiMapped: true, ofapiAuthStatus: null,
      kinds: [
        { linkKind: "tracking", lastUsableAt: "2026-10-09T09:45:26.000Z", lastUsableRunRef: "2", linkCount: 1, lastAttempt: attempt("complete", true, null, "2026-10-09T09:45:26.000Z"), stale: false, staleSince: null },
        { linkKind: "trial", lastUsableAt: "2026-10-09T03:45:30.000Z", lastUsableRunRef: "620", linkCount: 3, lastAttempt: attempt("failed", false, "OFAPI governed response body read failed"), stale: false, staleSince: null },
      ],
    }],
    links: [
      link(),
      link({ linkRef: "11170787", name: "Erome", state: "active", isFinished: false, linkEndsAt: null, clicks: 124, claims: 76, fans: 76,
        vendorMoney: { revenueBasis: "creator_net_after_platform_fee", netMills: 728_000, chargebacksMills: 0, calculatedAt: "2026-10-05T07:07:31.000Z", isLoading: false,
          lastRecalculation: { observedAt: "2026-09-09T16:45:06.000Z", previousObservedAt: "2026-09-09T04:45:33.000Z", fromMills: 992_000, toMills: 728_000, bindingChanged: false, accountChangedAt: "2026-09-05T16:45:09.000Z" } },
        binding: { channelKey: "lora.porntoki", channelTitle: "Порнтоки", validFrom: "2026-03-31T21:00:00.000Z", validTo: null, validFromBasis: "confirmed",
          contractor: { contractorKey: "coraline-red", contractorTitle: "@coraline_red", validFrom: "2026-03-31T21:00:00.000Z", validTo: null, validFromBasis: "confirmed" } } }),
      link({ linkRef: "11687581", name: "SpankBang", state: "active", isFinished: false, linkEndsAt: null, clicks: 0, claims: 0, fans: 0, spenders: null,
        vendorMoney: { revenueBasis: "creator_net_after_platform_fee", netMills: null, chargebacksMills: null, calculatedAt: null, isLoading: true, lastRecalculation: null }, binding: null }),
    ],
    ...overrides,
  };
}

function query(data?: unknown, error = false) {
  return { data, error: error ? new Error("Read failed") : null, isError: error, isPending: data === undefined && !error, refetch: vi.fn() };
}
function render() {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(MemoryRouter, { initialEntries: ["/ofapi-marketing?page=lora-vip-of"] }, createElement(OfapiMarketing))));
}
const emptyMarketing: MarketingDashboard = { resources: [], analytics: [], intents: [] } as unknown as MarketingDashboard;

beforeEach(() => {
  mocks.links.mockReset().mockReturnValue(query(snapshot()));
  mocks.marketing.mockReset().mockReturnValue(query(emptyMarketing));
});

describe("«Ссылки OnlyFans» screen", () => {
  it("shows the links of the series: claims as fans of a trial link, net money, state, channel, Hub money as no data yet", () => {
    const html = render();
    expect(html).toContain("Ссылки OnlyFans");
    expect(html).toContain("Ссылки страницы lora-vip-of");
    expect(html).toContain("2 939");
    expect(html).toContain("активации");
    expect(html).toContain("$13,483.44");
    expect(html).toContain("Истекла");
    expect(html).toContain("Reddit");
    expect(html).toContain("начало не подтверждено");
    expect(html).toContain("Порнтоки");
    expect(html).toContain("@coraline_red");
    expect(html).toContain("без канала");
    expect(html).toContain("OFAPI ещё считает");
    expect(html).toContain("Hub пока не считает");
    expect(html).toContain("пересчёт 09.09.26");
    expect(html).toContain("$992.00 → $728.00");
    expect(html).not.toContain("Подписки 0");
  });

  it("warns above the table when the page's last read gave nothing", () => {
    expect(render()).toContain("Trial-ссылки: последний сбор не дал данных. Последняя попытка 09.10, 15:46 — ошибка: OFAPI governed response body read failed. Показаны данные сбора 09.10, 06:45.");
  });

  it("keeps the Smart Links block closed while nothing of them exists, and says so", () => {
    const html = render();
    expect(html).toContain("Не используются: нет ни ссылок, ни пикселей, ни postbacks, ни действий.");
    expect(html).toContain('data-smart-links="closed"');
    expect(html).not.toContain("Smart Links этой страницы");
    expect(html).not.toContain("Окно атрибуции");
  });

  it("opens the Smart Links block by itself when an action exists", () => {
    mocks.marketing.mockReturnValue(query({ ...emptyMarketing, intents: [{ id: "a", state: "succeeded", accountingState: "complete", projectionState: "complete" }] }));
    const html = render();
    expect(html).toContain('data-smart-links="open"');
    expect(html).toContain("Окно атрибуции — 6 часов");
  });

  it("does not turn a failed links read into an empty page", () => {
    mocks.links.mockReturnValue(query(undefined, true));
    const html = render();
    expect(html).toContain("Read failed");
    expect(html).not.toContain("Ряд ссылок этой страницы ещё не собирался");
  });
});

describe("the screen's rules", () => {
  it("polls the marketing read every 15 s only while asked, and asks only while an action is in flight", () => {
    const dispatching = { intents: [{ state: "dispatching", accountingState: "pending", projectionState: "pending" }] } as unknown as MarketingDashboard;
    const settled = { intents: [{ state: "succeeded", accountingState: "complete", projectionState: "complete" }] } as unknown as MarketingDashboard;
    const pending = { intents: [{ state: "succeeded", accountingState: "pending", projectionState: "complete" }] } as unknown as MarketingDashboard;
    expect(marketingActionInFlight(dispatching.intents)).toBe(true);
    expect(marketingActionInFlight(pending.intents)).toBe(true);
    expect(marketingActionInFlight(settled.intents)).toBe(false);
    expect(marketingActionInFlight([{ state: "prepared" }] as unknown as MarketingDashboard["intents"])).toBe(false);
    const open = (data: MarketingDashboard | undefined) => marketingActionInFlight(data?.intents);
    expect(marketingRefetchInterval(open)({ state: { data: dispatching } })).toBe(MARKETING_POLL_MS);
    expect(marketingRefetchInterval(open)({ state: { data: settled } })).toBe(false);
    expect(marketingRefetchInterval(() => false)({ state: { data: dispatching } })).toBe(false);
    expect(marketingRefetchInterval(undefined)({ state: { data: dispatching } })).toBe(false);
  });

  it("lets a one-off read target only a link picked on the current page, for the current read, still offered", () => {
    const picked = { pageId: 9, selection: "trial_link", id: "11170787" };
    const vipLinks = [{ id: "11170787" }, { id: "10802699" }];
    expect(effectivePickedLink(picked, { pageId: 9, selection: "trial_link", links: vipLinks })).toBe("11170787");
    // The selected page left the active list on refresh: the form moved to page 8.
    expect(effectivePickedLink(picked, { pageId: 8, selection: "trial_link", links: [{ id: "2099377" }] })).toBe("");
    expect(effectivePickedLink(picked, { pageId: 9, selection: "trial_link_subscribers", links: vipLinks })).toBe("");
    expect(effectivePickedLink(picked, { pageId: 9, selection: "trial_link", links: [{ id: "10802699" }] })).toBe("");
    expect(effectivePickedLink(null, { pageId: 9, selection: "trial_link", links: vipLinks })).toBe("");
  });

  it("treats Smart Links as used when a link, a pixel, a postback or an action exists", () => {
    expect(smartLinksHaveData(undefined)).toBe(false);
    expect(smartLinksHaveData(emptyMarketing)).toBe(false);
    expect(smartLinksHaveData({ ...emptyMarketing, resources: [{ kind: "tracking" }] } as unknown as MarketingDashboard)).toBe(false);
    expect(smartLinksHaveData({ ...emptyMarketing, resources: [{ kind: "pixel" }] } as unknown as MarketingDashboard)).toBe(true);
  });

  it("states a stale list with its last usable read and attempt, and an unmapped page", () => {
    const page = snapshot().pages[0]!;
    const stale = { ...page, ofapiMapped: false, kinds: [{ ...page.kinds[0]!, stale: true, staleSince: "2026-10-07T21:45:17.000Z", lastUsableAt: "2026-10-07T21:45:17.000Z", lastAttempt: attempt("skipped", false, "page_auth_dead") }] };
    expect(pageWarnings(stale, 15)).toEqual([
      "Страница не привязана к аккаунту OFAPI: ссылки не собираются.",
      "Tracking-ссылки: не обновлялись с 08.10, 00:45 — дольше 15 ч. Последняя попытка 09.10, 15:46 — попытки не было: сессия страницы в OFAPI не действует.",
    ]);
    expect(pageWarnings({ ...page, kinds: [page.kinds[0]!] }, 15)).toEqual([]);
  });

  it("orders active links first by fans, filters by state and sums what is shown", () => {
    const links = snapshot().links;
    expect(sortLinks(links).map((row) => row.linkRef)).toEqual(["11170787", "11687581", "10802699"]);
    expect(filterLinks(links, "closed").map((row) => row.linkRef)).toEqual(["10802699"]);
    expect(linkTotals(links)).toEqual({ clicks: 11_798, fans: 3_015, vendorMills: 14_211_440, unknownMoney: 1 });
  });

  it("names the link's state and money in the owner's words", () => {
    expect(linkStateView({ state: "active", linkEndsAt: null })).toMatchObject({ label: "Активна", detail: "без срока" });
    expect(linkStateView({ state: "expired", linkEndsAt: "2026-09-30T00:42:13.000Z" })).toMatchObject({ label: "Истекла", detail: "30.09.26" });
    expect(vendorMoneyView(snapshot().links[1]!).recalculation).toEqual({
      when: "пересчёт 09.09.26", change: "$992.00 → $728.00", account: "после смены аккаунта 05.09.26",
    });
    expect(hubMoneyView(link())).toEqual({ amount: null, note: "Hub пока не считает" });
    expect(hubMoneyView(link({ hubMoney: { ...noHub, state: "available", reason: null, netMills: 120_000, pendingMills: 0, floorAt: "2026-10-09T00:00:00.000Z", transactionCount: 2, fanCount: 1 } })))
      .toEqual({ amount: "$120.00", note: "с 09.10.26" });
  });
});
