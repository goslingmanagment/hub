import { describe, expect, it } from "vitest";
import { authReturnTo, buildLoginRoute } from "../apps/dashboard/src/lib/authNavigation.js";
import { pageTransactionQuery } from "../apps/dashboard/src/lib/pageDetailNavigation.js";
import { creditBreakdownWindow } from "../apps/dashboard/src/lib/creditsNavigation.js";

describe("subsystem navigation scope", () => {
  it("keeps an authenticated deep link including its filters and anchor", () => {
    const target = "/pages/lora/fans/fansly/123?period=30d&backTo=%2Fpages%2Flora%3Ftab%3Dspenders#transactions";
    const login = new URL(buildLoginRoute(target), "https://hub.invalid");
    expect(login.pathname).toBe("/login");
    expect(authReturnTo(login.searchParams.get("returnTo"))).toBe(target);
  });
  it.each(["https://other.test", "//other.test", "/\\other.test", "/%2Fother.test", "/%5Cother.test", "/login?returnTo=/login", "/%6Cogin", "/%zz", "/pages/../login", "/\nother.test"])("rejects unsafe or looping login target %s", (target) => {
    expect(authReturnTo(target)).toBe("/");
  });
  it("does not broaden a pending or missing revenue window to all history", () => {
    expect(pageTransactionQuery("page", "7d", undefined, "", 0)).toBeUndefined();
    expect(pageTransactionQuery("page", "30d", { from: null, to: null }, "", 0)).toBeUndefined();
    expect(pageTransactionQuery("", "all", { from: null, to: null }, "", 0)).toBeUndefined();
  });
  it("reuses exact server dates and reportable predicate", () => {
    const window = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-08T00:00:00.000Z" };
    expect(pageTransactionQuery("page", "7d", window, "tip", 50)).toMatchObject({ ...window, pageLabel: "page", type: "tip", reportableOnly: true, offset: 50 });
    expect(pageTransactionQuery("page", "all", { from: null, to: null }, "", 0)).toMatchObject({ pageLabel: "page", reportableOnly: true });
    expect(pageTransactionQuery("page", "all", { from: null, to: null }, "", 0)).not.toHaveProperty("from");
  });
  it("uses the server's UTC breakdown days even if the browser clock has moved", () => {
    expect(creditBreakdownWindow([{ day: "2026-09-10" }, { day: "2026-09-04" }, { day: "2026-09-06" }])).toEqual({ from: "2026-09-04", to: "2026-09-10" });
    expect(creditBreakdownWindow([])).toBeNull();
  });
});
