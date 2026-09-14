import { createElement, isValidElement, type ChangeEvent, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queries: Object.fromEntries([
    "useAuthMe", "useOverview", "usePageRevenue", "usePageSubscribers", "usePageTransactions",
    "useSpenders", "usePageSpenderAutoLists", "usePageFollowersDaily", "usePageSubscribersDaily",
    "usePageRevenueDaily", "usePageFollowers", "usePageSpenderAutoList", "usePageDeletedFans",
  ].map((key) => [key, vi.fn()])),
  pathname: "/pages/lana",
  search: new URLSearchParams(),
  state: null as unknown,
  setSearch: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => mocks.queries);
vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: mocks.pathname, search: `?${mocks.search}`, state: mocks.state }),
  useParams: () => ({ pageLabel: "lana", bucketKey: "100-500" }),
  useSearchParams: () => [mocks.search, mocks.setSearch],
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/stores/periodStore", () => ({ usePeriodStore: () => ({ period: "7d" }) }));
vi.mock("@/stores/spenderPeriodStore", () => ({
  useSpenderPeriodStore: (selector: (state: { period: string }) => unknown) => selector({ period: "7d" }),
}));
vi.mock("@/components/layout/DashboardShellContext", () => ({
  useDashboardShell: () => ({
    pageCatalogState: "ready",
    pageCatalogError: null,
    findPageByLabel: () => ({ id: 1, label: "lana", platform: "fansly", modelSlug: "lana", modelName: "Lana", username: "lana" }),
  }),
}));

import { DeletedFansPage } from "../apps/dashboard/src/pages/DeletedFansPage.tsx";
import { FollowersPage } from "../apps/dashboard/src/pages/FollowersPage.tsx";
import { PageDetailPage } from "../apps/dashboard/src/pages/PageDetailPage.tsx";
import { SpenderAutoListPage } from "../apps/dashboard/src/pages/SpenderAutoListPage.tsx";
import { resolveFanProfileBackTarget } from "../apps/dashboard/src/lib/navigation.ts";

type Element = ReactElement<Record<string, unknown>>;
const page = { id: 1, label: "lana", platform: "fansly", modelSlug: "lana", modelName: "Lana" };
const overviewBackTo = "/?period=30d&row=lana&chart=page%3Alana&sort=decline";
const read = (data: unknown) => ({ data, isLoading: data === undefined, isError: false, refetch: vi.fn() });

// Render the actual page with isolated transport/router hooks, retaining its
// element tree so the tests can execute the same event callbacks as the UI.
function capture(Page: () => ReactNode): ReactNode {
  let tree: ReactNode;
  function Capture() {
    tree = Page();
    return tree;
  }
  renderToStaticMarkup(createElement(Capture));
  return tree;
}

function allElements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(allElements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...allElements(node.props.children as ReactNode)];
}

function findElement(tree: ReactNode, predicate: (element: Element) => boolean): Element {
  const element = allElements(tree).find(predicate);
  if (!element) throw new Error("Expected page control was not rendered");
  return element;
}

function applySearchChange() {
  expect(mocks.setSearch).toHaveBeenCalledTimes(1);
  const [change, options] = mocks.setSearch.mock.calls[0] as [
    (previous: URLSearchParams) => URLSearchParams,
    { state?: unknown } | undefined,
  ];
  mocks.search = change(mocks.search);
  // React Router does not implicitly retain the previous location's state.
  mocks.state = options?.state ?? null;
  return mocks.search;
}

beforeEach(() => {
  mocks.pathname = "/pages/lana";
  mocks.search = new URLSearchParams("period=30d&tab=transactions&type=tip&txOffset=100&spendersOffset=50&offset=50&query=buyer");
  mocks.state = { backTo: overviewBackTo, source: { view: "overview" } };
  mocks.setSearch.mockReset();
  mocks.navigate.mockReset();
  for (const query of Object.values(mocks.queries)) query.mockReset().mockReturnValue(read(undefined));
  mocks.queries.useAuthMe!.mockReturnValue(read({ user: { role: "owner" } }));
  mocks.queries.usePageTransactions!.mockReturnValue(read({ page, items: [], total: 150 }));
  mocks.queries.useSpenders!.mockReturnValue(read({ scope: { page }, items: [], total: 150 }));
  mocks.queries.usePageFollowers!.mockReturnValue(read({ page, items: [], total: 150 }));
  mocks.queries.usePageDeletedFans!.mockReturnValue(read({ page, items: [], total: 150 }));
  mocks.queries.usePageSpenderAutoList!.mockReturnValue(read({
    page, bucket: { label: "$100–500" }, total: 150,
    items: [{
      fan: { platformUserId: "fan-1", username: "buyer", displayName: "Buyer", pageAlias: null },
      isFollower: true, subscriptionStatus: "never", grossAmountMills: 125000,
      creatorNetAmountMills: 100000, lastTransactionAt: null,
    }],
  }));
});

describe("daily URL controls retain the originating navigation state", () => {
  it.each(["tab", "type", "transactions", "spenders"] as const)("preserves Overview after changing %s", (action) => {
    if (action === "spenders") mocks.search.set("tab", "spenders");
    const state = mocks.state;
    const tree = capture(PageDetailPage);
    if (action === "tab") {
      const control = findElement(tree, (element) => element.type === "button" && element.props.children === "Spenders");
      (control.props.onClick as () => void)();
    } else {
      const prop = action === "type" ? "onTxTypeChange" : action === "transactions" ? "onTxPageChange" : "onPageChange";
      const control = findElement(tree, (element) => typeof element.props[prop] === "function");
      (control.props[prop] as (value: string | number) => void)(action === "type" ? "subscription" : 150);
    }
    const search = applySearchChange();
    expect(mocks.state).toBe(state);
    expect(resolveFanProfileBackTarget(mocks.state, undefined)).toBe(overviewBackTo);
    expect(search.get("period")).toBe("30d");
    expect(search.get("query")).toBe("buyer");
    if (action === "tab") expect(search.get("tab")).toBe("spenders");
    if (action === "type") {
      expect(search.get("type")).toBe("subscription");
      expect(search.has("txOffset")).toBe(false);
      expect(search.get("spendersOffset")).toBe("50");
    }
    if (action === "transactions") expect(search.get("txOffset")).toBe("150");
    if (action === "spenders") expect(search.get("spendersOffset")).toBe("150");
  });

  it("retains nested return state while narrowing Followers", () => {
    mocks.pathname = "/pages/lana/followers";
    mocks.search.set("backTo", overviewBackTo);
    const state = mocks.state;
    const control = findElement(capture(FollowersPage), (element) => Array.isArray(element.props.filters));
    (control.props.onChange as (value: string) => void)("active");
    const search = applySearchChange();
    expect(mocks.state).toBe(state);
    expect(search.get("backTo")).toBe(overviewBackTo);
    expect(search.get("filter")).toBe("active");
    expect(search.get("query")).toBe("buyer");
    expect(search.has("offset")).toBe(false);
  });

  it("retains return state and unrelated URL fields while paging DeletedFans", () => {
    mocks.pathname = "/pages/lana/deleted-fans";
    const state = mocks.state;
    const control = findElement(capture(DeletedFansPage), (element) => typeof element.props.onPageChange === "function");
    (control.props.onPageChange as (value: number) => void)(100);
    expect(applySearchChange().get("offset")).toBe("100");
    expect(mocks.state).toBe(state);
    expect(mocks.search.get("period")).toBe("30d");
  });

  it("retains return state and period while changing the AutoList follower filter", () => {
    mocks.pathname = "/pages/lana/spender-autolists/100-500";
    const state = mocks.state;
    const control = findElement(capture(SpenderAutoListPage), (element) => element.type === "input" && element.props.type === "checkbox");
    (control.props.onChange as (event: ChangeEvent<HTMLInputElement>) => void)({ target: { checked: true } } as ChangeEvent<HTMLInputElement>);
    const search = applySearchChange();
    expect(mocks.state).toBe(state);
    expect(search.get("followersOnly")).toBe("true");
    expect(search.get("period")).toBe("30d");
    expect(search.get("query")).toBe("buyer");
    expect(search.has("offset")).toBe(false);
  });
});

function autoListRow() {
  mocks.pathname = "/pages/lana/spender-autolists/100-500";
  const tree = capture(SpenderAutoListPage);
  return findElement(tree, (element) => element.type === "tr" && typeof element.props.onClick === "function");
}

function clickRow(row: Element, changes: Record<string, unknown> = {}) {
  const event = {
    button: 0, defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    target: { closest: () => null }, ...changes,
  } as unknown as MouseEvent<HTMLTableRowElement>;
  (row.props.onClick as (event: MouseEvent<HTMLTableRowElement>) => void)(event);
}

describe("AutoList row navigation keeps the fan link's normal behavior", () => {
  it("opens a fan once from an ordinary cell with the same period and complete return query as its link", () => {
    const row = autoListRow();
    const link = findElement(row, (element) => typeof element.props.to === "string");
    clickRow(row);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(link.props.to, { state: link.props.state });
    expect(link.props.to).toBe("/pages/lana/fans/fansly/fan-1?period=30d");
    expect(link.props.state).toEqual(expect.objectContaining({
      backTo: `${mocks.pathname}?${mocks.search}`,
    }));
  });

  it.each([
    { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true },
    { button: 1 }, { defaultPrevented: true },
  ])("does not hijack a modified or already-handled click: %j", (event) => {
    clickRow(autoListRow(), event);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it.each(["a", "button", "input", "select", "textarea"])("leaves nested %s interaction to that control", (tag) => {
    clickRow(autoListRow(), { target: { closest: (selector: string) => selector.split(", ").includes(tag) ? { tagName: tag.toUpperCase() } : null } });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
