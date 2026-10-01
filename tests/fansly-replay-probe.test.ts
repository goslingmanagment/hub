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

  it("runs only the decisive transaction query-shape matrix when parity mode is selected", async () => {
    const getTransactionsPage = vi.fn(async () => ({
      items: [],
      total: 0,
      done: true,
      contractAccepted: true,
      raw: [],
    }));
    const after = new Date("2026-08-22T16:43:46.000Z");
    const results = await runFanslyReplayProbe(fakeApp({ getTransactionsPage }), {
      pageLabels: ["lilly-1"],
      calls: 1,
      transactionsParity: true,
      transactionsAfter: after,
    });

    expect(results.map((result) => result.family)).toEqual([
      "earnings/transactions?bounds=omitted",
      "earnings/transactions?bounds=after-only",
      "earnings/transactions?bounds=after-before-empty",
      "earnings/transactions?bounds=after-before-now",
    ]);
    expect(getTransactionsPage).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ unboundedQueryShape: "omitted", limit: 10, offset: 0 }),
    );
    expect(getTransactionsPage).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ after, unboundedQueryShape: "omitted", limit: 10, offset: 0 }),
    );
    expect(getTransactionsPage).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.objectContaining({ after, unboundedQueryShape: "present-empty", limit: 10, offset: 0 }),
    );
    expect(getTransactionsPage).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      expect.objectContaining({ after, before: expect.any(Date), limit: 10, offset: 0 }),
    );
    expect(results.every((result) => result.reportedTotal === 0)).toBe(true);
  });

  it("requires a lower bound for transaction parity mode", async () => {
    await expect(runFanslyReplayProbe(fakeApp({}), {
      pageLabels: ["lilly-1"],
      transactionsParity: true,
      dryRun: true,
    })).rejects.toThrow(/transactions parity requires/);
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

  it("rejects a non-positive calls count instead of silently firing zero probes (review R1-5)", async () => {
    await expect(
      runFanslyReplayProbe(fakeApp({}), { pageLabels: ["lilly-1"], calls: Number.NaN, dryRun: true }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      runFanslyReplayProbe(fakeApp({}), { pageLabels: ["lilly-1"], calls: 0, dryRun: true }),
    ).rejects.toThrow(/positive integer/);
  });
});

describe("summarizeReplayProbe verdict line (review R1-5)", () => {
  it("refuses a verdict when no real probes fired (dry-run)", () => {
    const summary = summarizeReplayProbe([
      {
        page: "p1",
        family: "earnings/stats/accounts",
        attempt: 1,
        verdict: "skipped",
        httpStatus: null,
        errorCode: null,
        itemCount: null,
        reportedTotal: null,
        done: null,
        contractAccepted: null,
        wallClockMs: 0,
        message: "dry-run (not called)",
      },
    ]);
    expect(summary).toContain("NO PROBES FIRED");
    expect(summary).not.toContain("No auth rejections");
  });

  it("keeps the green line for a real all-replayable run", () => {
    const summary = summarizeReplayProbe([
      {
        page: "p1",
        family: "earnings/stats/accounts",
        attempt: 1,
        verdict: "replayable",
        httpStatus: 200,
        errorCode: null,
        itemCount: 3,
        reportedTotal: null,
        done: null,
        contractAccepted: null,
        wallClockMs: 12,
        message: null,
      },
    ]);
    expect(summary).toContain("No auth rejections");
  });
});
