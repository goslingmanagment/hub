import { describe, expect, it } from "vitest";

import type { FanslyEarningsTransaction } from "@agency_hub_core/fansly";

import {
  buildTopSpendersBootstrapWindows,
  findTransactionPageOverlap,
  inWindowItemsAfterOlder,
  mapFanslyTransactionItem,
  partitionTopSpenderItems,
  resolveFanslyCommissionRate,
  splitTopSpendersWindow,
} from "../apps/runtime/src/services/sync/money-rules.ts";
import {
  fanEarningsRequest,
  fanEarningsSubjectOfRequest,
} from "../apps/runtime/src/sync/fansly/resources/fan-earnings.ts";
import {
  parsePurchaseTargetSubject,
  purchaseTargetFollowups,
  purchaseTargetsOfTransactions,
  purchaseTargetSubject,
} from "../apps/runtime/src/sync/fansly/resources/purchases.ts";
import {
  headWalkDecision,
  parseTransactionsCursor,
  rescanLowerBound,
  TRANSACTIONS_HEAD_ESCALATE_OFFSET,
  TRANSACTIONS_LOOKBACK_MS,
  TRANSACTIONS_RESCAN_CAP_MS,
} from "../apps/runtime/src/sync/fansly/resources/transactions.ts";

// The pure parts of the money resources (design §5.6–§5.10): the ledger row a
// served transaction becomes (shared with the legacy lane), the walk rules of
// the transactions variants, the purchase targets a ledger page names, the
// earnings subject a request reads, and the top-spender windows.

const NOW = new Date("2026-10-02T12:00:00Z");
const DAY = 86_400_000;

function item(overrides: Partial<FanslyEarningsTransaction> = {}): FanslyEarningsTransaction {
  return {
    walletId: "wallet-1",
    transactionId: "tx-1",
    accountId: "300000000000000001",
    correlationId: null,
    correlationAccountId: "500000000000000001",
    type: 7001,
    destination: 1,
    amount: 10_000,
    destinationTax: 2_000,
    destinationAmount: 8_000,
    newBalance: null,
    newBalance64: 100_000,
    createdAt: NOW.getTime() - DAY,
    updatedAt: null,
    status: 2,
    senderId: "500000000000000001",
    receiverId: "300000000000000001",
    ...overrides,
  };
}

describe("a served transaction as its ledger row", () => {
  it("keeps a stated gross and net in mills", () => {
    const { row, commissionFellBack } = mapFanslyTransactionItem(item(), 0.3);
    expect(commissionFellBack).toBe(false);
    expect(row).toMatchObject({
      transactionId: "tx-1",
      grossAmountMills: 10_000n,
      creatorNetAmountMills: 8_000n,
      sourceDestinationAmountMills: 8_000n,
      newBalanceMills: 100_000n,
      rawType: 7001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      rawDestinationTax: 2_000,
    });
    expect(row.occurredAt).toEqual(new Date(NOW.getTime() - DAY));
    expect(row.sourceUpdatedAt).toBeNull();
  });

  it("derives the gross of a net-only row from the stated commission, else the page's", () => {
    const stated = mapFanslyTransactionItem(item({ amount: 8_000, destinationAmount: 8_000, destinationTax: 2_000 }), 0.5);
    expect(stated.row.grossAmountMills).toBe(10_000n);
    expect(stated.commissionFellBack).toBe(false);

    const fallback = mapFanslyTransactionItem(item({ amount: 8_000, destinationAmount: 8_000, destinationTax: null }), 0.2);
    expect(fallback.row.grossAmountMills).toBe(10_000n);
    expect(fallback.commissionFellBack).toBe(true);
    // A gross the provider stated never counts as a fallback.
    expect(mapFanslyTransactionItem(item({ destinationTax: null }), 0.2).commissionFellBack).toBe(false);
  });

  it("refuses an out-of-range commission", () => {
    expect(resolveFanslyCommissionRate(2_000, 0.3)).toEqual({ commissionRate: 0.2, fellBack: false });
    expect(resolveFanslyCommissionRate(10_001, 0.3)).toEqual({ commissionRate: 0.3, fellBack: true });
    expect(resolveFanslyCommissionRate(-1, 0.3)).toEqual({ commissionRate: 0.3, fellBack: true });
    expect(resolveFanslyCommissionRate(12.5, 0.3)).toEqual({ commissionRate: 0.3, fellBack: true });
  });
});

describe("offset pages of the ledger", () => {
  it("name the rows served on two pages", () => {
    expect(findTransactionPageOverlap(undefined, [item()])).toEqual([]);
    expect(findTransactionPageOverlap(["tx-0", "tx-1"], [item(), item({ transactionId: "tx-2" })])).toEqual(["tx-1"]);
  });

  it("name the in-window rows listed after an older one", () => {
    const after = new Date(NOW.getTime() - 2 * DAY);
    const rows = [
      item({ transactionId: "a", createdAt: NOW.getTime() - DAY }),
      item({ transactionId: "b", createdAt: NOW.getTime() - 3 * DAY }),
      item({ transactionId: "c", createdAt: NOW.getTime() - DAY }),
    ];
    expect(inWindowItemsAfterOlder(rows, after).map((row) => row.transactionId)).toEqual(["c"]);
  });
});

describe("transactions walks", () => {
  it("the rescan reaches back 7 days from the checkpoint, or to an older pending row, never past 30 days", () => {
    const cursor = new Date(NOW.getTime() - DAY);
    expect(rescanLowerBound({ cursorTimestamp: cursor, oldestPendingAt: null, now: NOW })).toEqual({
      after: new Date(cursor.getTime() - TRANSACTIONS_LOOKBACK_MS),
      clamped: false,
    });
    const pending = new Date(NOW.getTime() - 20 * DAY);
    expect(rescanLowerBound({ cursorTimestamp: cursor, oldestPendingAt: pending, now: NOW }).after).toEqual(pending);
    const ancient = new Date(NOW.getTime() - 90 * DAY);
    expect(rescanLowerBound({ cursorTimestamp: cursor, oldestPendingAt: ancient, now: NOW })).toEqual({
      after: new Date(NOW.getTime() - TRANSACTIONS_RESCAN_CAP_MS),
      clamped: true,
    });
    // A checkpoint older than the cap: the bound stays just above it, so the
    // page holding the checkpoint row still stops the walk.
    const stale = new Date(NOW.getTime() - 40 * DAY);
    expect(rescanLowerBound({ cursorTimestamp: stale, oldestPendingAt: null, now: NOW }).after).toEqual(new Date(stale.getTime() + 1));
    expect(rescanLowerBound({ cursorTimestamp: null, oldestPendingAt: null, now: NOW }).after).toBeNull();
  });

  it("the head stops on a known unchanged row only once every demanded id was served", () => {
    const base = { offset: 0, itemCount: 20, total: 500, demanded: [] as string[], demandOverflow: false, seenDemanded: [] as string[] };
    expect(headWalkDecision({ ...base, knownUnchanged: true }).stop).toBe("known_item");
    expect(headWalkDecision({ ...base, knownUnchanged: true, demanded: ["tx-9"] })).toEqual({ stop: null, unseen: ["tx-9"] });
    expect(headWalkDecision({ ...base, knownUnchanged: true, demanded: ["tx-9"], seenDemanded: ["tx-9"] }).stop).toBe("known_item");
    // Demand that overflowed its id list never proves the walk reached it.
    expect(headWalkDecision({ ...base, knownUnchanged: true, demandOverflow: true }).stop).toBeNull();
  });

  it("the head ends with the list, or escalates at offset 200", () => {
    const base = { total: 500, knownUnchanged: false, demanded: [] as string[], demandOverflow: false, seenDemanded: [] as string[] };
    expect(headWalkDecision({ ...base, offset: 40, itemCount: 7 }).stop).toBe("end");
    expect(headWalkDecision({ ...base, offset: 0, itemCount: 20, total: 20 }).stop).toBe("end");
    expect(headWalkDecision({ ...base, offset: TRANSACTIONS_HEAD_ESCALATE_OFFSET - 40, itemCount: 20 }).stop).toBeNull();
    expect(headWalkDecision({ ...base, offset: TRANSACTIONS_HEAD_ESCALATE_OFFSET - 20, itemCount: 20 }).stop).toBe("escalated");
  });

  it("a cursor survives whatever its row holds", () => {
    expect(parseTransactionsCursor(null)).toEqual({ cursorTimestamp: null, walk: null, restartCount: 0, last: null, shadow: null });
    expect(parseTransactionsCursor({ cursorTimestamp: "nope", walk: { offset: -1 }, restartCount: "2", shadow: { steps: 3 } }))
      .toEqual({ cursorTimestamp: null, walk: null, restartCount: 0, last: null, shadow: null });
    const walk = { startedAt: NOW.toISOString(), offset: 40, pages: 2, fetched: 40, total: 99, lastPageIds: ["a", 1], after: null, newestSeenAt: null, seenDemanded: [] };
    expect(parseTransactionsCursor({ walk, restartCount: 1 }).walk).toMatchObject({ offset: 40, total: 99, lastPageIds: ["a"] });
  });
});

describe("purchase targets", () => {
  it("are the NEW PPV rows' content ids: 2010/2110 media, 2016/2116 bundle", () => {
    expect(purchaseTargetsOfTransactions([
      { rawType: 2110, correlationId: "880000000000000002" },
      { rawType: "2016", correlationId: "770000000000000001" },
      { rawType: 2010, correlationId: "880000000000000002" },
      { rawType: 7001, correlationId: "990000000000000001" },
      { rawType: 2116, correlationId: null },
    ])).toEqual({
      targets: [{ kind: "bundle", id: "770000000000000001" }, { kind: "media", id: "880000000000000002" }],
      conflicts: [],
    });
  });

  it("leave out a content id seen as both kinds instead of guessing", () => {
    expect(purchaseTargetsOfTransactions([
      { rawType: 2010, correlationId: "880000000000000003" },
      { rawType: 2016, correlationId: "880000000000000003" },
      { rawType: 2010, correlationId: "880000000000000004" },
    ])).toEqual({ targets: [{ kind: "media", id: "880000000000000004" }], conflicts: ["880000000000000003"] });
  });

  it("are one work row each, named by their subject", () => {
    const target = { kind: "bundle" as const, id: "770000000000000001" };
    expect(purchaseTargetSubject(target)).toBe("bundle:770000000000000001");
    expect(parsePurchaseTargetSubject("bundle:770000000000000001")).toEqual(target);
    for (const bad of ["", "media:", "single:1", "media:12a", ":1"]) expect(parsePurchaseTargetSubject(bad), bad).toBeNull();
    expect(purchaseTargetFollowups([target], "transactions.head")).toEqual([{
      resource: "purchases.targets",
      subject: "bundle:770000000000000001",
      params: { target },
      demand: { reason: "transactions.head" },
    }]);
  });
});

describe("fan earnings subjects", () => {
  it("one endpoint for one fan per request, the whole history up to now", () => {
    const lifetime = fanEarningsRequest({ fanRef: "500000000000000007", window: "lifetime" }, NOW);
    expect(lifetime).toEqual({
      spec: "earnings.stats_accounts",
      params: { correlationAccountId: "500000000000000007", afterMs: 0, beforeMs: NOW.getTime() },
    });
    expect(fanEarningsSubjectOfRequest(lifetime)).toEqual({ fanRef: "500000000000000007", window: "lifetime" });
    const monthly = fanEarningsRequest({ fanRef: "500000000000000007", window: "monthly" }, NOW);
    expect(monthly.spec).toBe("earnings.monthly_accounts");
    expect(fanEarningsSubjectOfRequest(monthly)).toEqual({ fanRef: "500000000000000007", window: "monthly" });
    expect(fanEarningsSubjectOfRequest({ spec: "earnings.accounts", params: { afterMs: 0, beforeMs: NOW.getTime() } })).toBeNull();
    expect(fanEarningsSubjectOfRequest({ spec: "earnings.stats_accounts", params: {} })).toBeNull();
  });
});

describe("top spenders", () => {
  it("bootstrap windows are UTC months from the account's creation to now", () => {
    const windows = buildTopSpendersBootstrapWindows(new Date("2026-08-15T00:00:00Z"), NOW);
    expect(windows.map((window) => [window.monthKey, window.startedAt, window.endedAt])).toEqual([
      ["2026-08", "2026-08-15T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
      ["2026-09", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"],
      ["2026-10", "2026-10-01T00:00:00.000Z", NOW.toISOString()],
    ]);
  });

  it("a capped window splits month → weeks → days, and a day no further", () => {
    const [month] = buildTopSpendersBootstrapWindows(new Date("2026-09-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
    const weeks = splitTopSpendersWindow(month!)!;
    expect(weeks.map((week) => week.kind)).toEqual(["week", "week", "week", "week", "week"]);
    expect(weeks.at(-1)!.endedAt).toBe("2026-10-01T00:00:00.000Z");
    const days = splitTopSpendersWindow(weeks[0]!)!;
    expect(days).toHaveLength(7);
    expect(splitTopSpendersWindow(days[0]!)).toBeNull();
  });

  it("a row names its spender by correlation account, else by account", () => {
    const partition = partitionTopSpenderItems([
      { totalGross: 1_000, totalNet: 800, correlationAccountId: "500000000000000001", accountId: "300000000000000001" },
      { totalGross: 500, totalNet: 400, correlationAccountId: "", accountId: "600000000000000001" },
      { totalGross: 100, totalNet: 80, correlationAccountId: null, accountId: null },
    ]);
    expect(partition.valid.map((row) => row.sourceIdentityKey)).toEqual(["fan:500000000000000001", "account:600000000000000001"]);
    expect(partition.skippedCount).toBe(1);
    expect(partition.skippedExamples).toEqual([{ accountId: null, correlationAccountId: null }]);
  });
});
