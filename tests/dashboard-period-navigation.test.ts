import type { ChangeEvent, ReactElement, SelectHTMLAttributes } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({
  pathname: "/pages/lana/fans/fansly/123",
  state: { backTo: "/pages/lana/top-supporters?period=7d&q=buyer&offset=50", fanLabel: "Buyer" },
  search: new URLSearchParams(),
  setSearch: vi.fn(),
  setPeriod: vi.fn(),
}));
vi.mock("react-router", () => ({ useLocation: () => route, useSearchParams: () => [route.search, route.setSearch] }));
vi.mock("@/stores/periodStore", () => ({ usePeriodStore: () => ({ period: "7d", setPeriod: route.setPeriod }) }));
vi.mock("@/stores/spenderPeriodStore", () => ({ useSpenderPeriodStore: () => ({ period: "7d", topSupportersPeriod: "all", setPeriod: route.setPeriod, setTopSupportersPeriod: route.setPeriod }) }));
import { PeriodSelector } from "../apps/dashboard/src/components/shared/PeriodSelector.tsx";

function choosePeriod(mode: "dashboard" | "spender" | "topSupporters") {
  // The router/store hooks are isolated; invoke the actual narrow control's handler.
  const element = PeriodSelector({ mode }) as ReactElement<{ children: ReactElement[] }>;
  const select = element.props.children[0] as ReactElement<SelectHTMLAttributes<HTMLSelectElement>>;
  select.props.onChange!({ target: { value: "30d" } } as ChangeEvent<HTMLSelectElement>);
  return route.setSearch.mock.calls[0] as [URLSearchParams, { state: typeof route.state }];
}

beforeEach(() => {
  route.pathname = "/pages/lana/fans/fansly/123";
  route.search = new URLSearchParams("period=7d&offset=50&spendersOffset=25&txOffset=100&q=buyer");
  route.setSearch.mockClear();
  route.setPeriod.mockClear();
});

describe("period changes keep the originating list", () => {
  it.each(["dashboard", "spender", "topSupporters"] as const)("preserves fan return state while resetting only periodic offsets in %s mode", (mode) => {
    const [search, options] = choosePeriod(mode);
    expect(search.get("period")).toBe("30d");
    expect(search.get("q")).toBe("buyer");
    expect(search.has("offset")).toBe(false);
    expect(search.has("spendersOffset")).toBe(false);
    expect(search.get("txOffset")).toBe("100");
    expect(options.state).toBe(route.state);
    expect(options.state.backTo).toContain("offset=50");
    expect(route.setPeriod).toHaveBeenCalledWith("30d");
  });
  it("keeps navigation state through the overview-specific query serializer", () => {
    route.pathname = "/";
    route.search = new URLSearchParams("period=7d");
    const [search, options] = choosePeriod("dashboard");
    expect(search.get("period")).toBe("30d");
    expect(options.state).toBe(route.state);
  });
});
