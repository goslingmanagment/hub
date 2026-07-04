import { afterEach, describe, expect, it, vi } from "vitest";

import { FanslyApiError } from "@agency_hub_core/fansly";

vi.mock("../apps/runtime/src/services/page-context.ts", () => ({
  resolvePageContext: vi.fn(async (_app: unknown, label: string) => ({
    page: { id: 1, label },
    platform: "fansly" as const,
    session: { authorization: "token", fanslyClientCheck: "check" },
    proxy: null,
    egressKey: `egress-${label}`,
  })),
}));

vi.mock("../apps/runtime/src/services/sync/rate-limiter.ts", () => ({
  createSyncRateLimitWaiter: vi.fn(() => vi.fn(async () => 0)),
}));

const { runFanslyReplayProbe, summarizeReplayProbe } = await import(
  "../apps/runtime/src/services/fansly-replay-probe.ts"
);

function fakeApp(adapter: unknown) {
  return { adapter } as never;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("runFanslyReplayProbe", () => {
  it("calls each family once per page per --calls and reports replayable on success", async () => {
    const calls: string[] = [];
    const ok = async () => {
      calls.push("call");
      return { items: [{ a: 1 }], raw: [] };
    };
    const adapter = {
      getEarningsStatsAccountsPage: ok,
      getEarningsMonthlyStatsAccountsPage: ok,
      getMediaOrderHistoryPage: ok,
    };

    const results = await runFanslyReplayProbe(fakeApp(adapter), {
      pageLabels: ["lilly-1", "lilly-2"],
      calls: 1,
    });

    // 3 families × 2 pages × 1 call
    expect(results).toHaveLength(6);
    expect(calls).toHaveLength(6);
    expect(results.every((r) => r.verdict === "replayable")).toBe(true);
    expect(results[0]?.itemCount).toBe(1);
  });

  it("classifies a 401/403 as auth-rejected (non-replayable) and other errors as route-rejected", async () => {
    const adapter = {
      getEarningsStatsAccountsPage: async () => {
        throw new FanslyApiError("auth failed", 401, 0);
      },
      getEarningsMonthlyStatsAccountsPage: async () => {
        throw new FanslyApiError("bad params", 400, 100);
      },
      getMediaOrderHistoryPage: async () => ({ items: [], raw: [] }),
    };

    const results = await runFanslyReplayProbe(fakeApp(adapter), {
      pageLabels: ["lilly-1"],
      calls: 1,
    });

    const byFamily = Object.fromEntries(results.map((r) => [r.family, r.verdict]));
    expect(byFamily["earnings/stats/accounts"]).toBe("auth-rejected");
    expect(byFamily["earnings/monthlystats/accounts"]).toBe("route-rejected");
    expect(byFamily["media/orderhistory"]).toBe("replayable");

    const summary = summarizeReplayProbe(results);
    expect(summary).toContain("AUTH REJECTION on: earnings/stats/accounts");
  });

  it("dry-run resolves contexts but fires no adapter calls", async () => {
    const spy = vi.fn();
    const adapter = {
      getEarningsStatsAccountsPage: spy,
      getEarningsMonthlyStatsAccountsPage: spy,
      getMediaOrderHistoryPage: spy,
    };

    const results = await runFanslyReplayProbe(fakeApp(adapter), {
      pageLabels: ["lilly-1"],
      calls: 1,
      dryRun: true,
    });

    expect(spy).not.toHaveBeenCalled();
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.message === "dry-run (not called)")).toBe(true);
  });

  it("rejects a non-Fansly page", async () => {
    const mod = await import("../apps/runtime/src/services/page-context.ts");
    vi.mocked(mod.resolvePageContext).mockResolvedValueOnce({
      page: { id: 2, label: "of-page" },
      platform: "onlyfans" as const,
      auth: {},
      proxy: null,
      egressKey: "e",
    } as never);

    await expect(
      runFanslyReplayProbe(fakeApp({}), { pageLabels: ["of-page"], calls: 1 }),
    ).rejects.toThrow(/not a Fansly page/);
  });
});
