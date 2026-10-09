// Hub's own money per OnlyFans link (traffic plan §2.4, PR 13): the pure
// rule `ofapi_subscription_period_equal_split.v1` — a fan's transaction is
// split equally over the links whose periods hold it; shares are integer
// mills and, with the unallocated part, always add up to the transaction.

import { describe, expect, it } from "vitest";

import {
  attributeHubLinkMoney,
  hubLinkKey,
  sumHubLinkMoney,
  type HubLinkPeriod,
  type HubLinkTransaction,
} from "@agency_hub_core/db";

const PAGE = 9;
const t = (hours: number) => new Date(Date.UTC(2026, 9, 9, 0, 0, 0) + hours * 3_600_000);
const floors = (entries: Array<[string, number]>) =>
  new Map(entries.map(([ref, hours]) => [hubLinkKey(PAGE, "trial", ref), t(hours)]));
const period = (ref: string, fanId: number, start: number | null, end: number | null): HubLinkPeriod => ({
  pageId: PAGE, linkKind: "trial", linkRef: ref, fanId,
  startAt: start === null ? null : t(start), endAt: end === null ? null : t(end),
});
let nextId = 1;
const tx = (fanId: number, hours: number, mills: bigint, extra: Partial<HubLinkTransaction> = {}): HubLinkTransaction => ({
  id: nextId++, pageId: PAGE, fanId, state: "posted", netMills: mills,
  occurredAt: t(hours), attributionAt: t(hours), negatesTransactionId: null, ...extra,
});
const shares = (result: ReturnType<typeof attributeHubLinkMoney>, transactionId: number) =>
  result.allocations.filter((row) => row.transactionId === transactionId).map((row) => [row.linkRef, row.mills]);

describe("attributeHubLinkMoney", () => {
  it("splits equally over the links whose periods hold the transaction; the remainder goes one mill at a time in link order", () => {
    const result = attributeHubLinkMoney({
      floors: floors([["11170786", 0], ["10802699", 0], ["11213035", 0]]),
      periods: [period("11170786", 1, null, null), period("10802699", 1, null, null), period("11213035", 1, 2, null)],
      transactions: [tx(1, 1, 1000n), tx(1, 3, 1000n), tx(1, 3, -10n)],
    });
    // Link order is the link number: 10802699 < 11170786 < 11213035.
    expect(shares(result, nextId - 3)).toEqual([["10802699", 500n], ["11170786", 500n]]);
    expect(shares(result, nextId - 2)).toEqual([["10802699", 334n], ["11170786", 333n], ["11213035", 333n]]);
    expect(shares(result, nextId - 1)).toEqual([["10802699", -4n], ["11170786", -3n], ["11213035", -3n]]);
  });

  it("counts nothing before a link's floor, ignores a link without one, and ends a period at its close (exclusive)", () => {
    const result = attributeHubLinkMoney({
      floors: floors([["1", 10]]),
      periods: [period("1", 1, null, 20), period("2", 1, null, null)],
      transactions: [tx(1, 5, 100n), tx(1, 10, 200n), tx(1, 19, 300n), tx(1, 20, 400n)],
    });
    expect(result.allocations.map((row) => [row.linkRef, row.mills])).toEqual([["1", 200n], ["1", 300n]]);
    expect(result.unallocated.map((row) => row.mills)).toEqual([100n, 400n]);
  });

  it("gives a chargeback the shares of its original purchase, reported at its own time; without the original, its own time decides", () => {
    const original = tx(1, 1, 3000n);
    const result = attributeHubLinkMoney({
      floors: floors([["1", 0], ["2", 0], ["3", 0]]),
      // At the purchase links 1 and 2 held the fan; at the chargeback only 3 does.
      periods: [period("1", 1, null, 2), period("2", 1, null, 2), period("3", 1, 2, null)],
      transactions: [
        original,
        tx(1, 5, -3000n, { attributionAt: original.attributionAt, negatesTransactionId: original.id }),
        tx(1, 5, -700n),
      ],
    });
    expect(shares(result, original.id + 1)).toEqual([["1", -1500n], ["2", -1500n]]);
    expect(result.allocations.find((row) => row.transactionId === original.id + 1)?.occurredAt).toEqual(t(5));
    expect(shares(result, original.id + 2)).toEqual([["3", -700n]]);
  });

  it("decides the recipients before any filter: one link's sum holds only its share", () => {
    const result = attributeHubLinkMoney({
      floors: floors([["1", 0], ["2", 0]]),
      periods: [period("1", 1, null, null), period("2", 1, null, null), period("1", 2, null, null)],
      transactions: [tx(1, 1, 1001n), tx(2, 1, 50n), tx(1, 2, 80n, { state: "pending" })],
    });
    expect(sumHubLinkMoney(result.allocations, { pageId: PAGE, linkKind: "trial", linkRef: "1", fromAt: t(0), toAt: t(24) }))
      .toEqual({ netMills: 501n + 50n, pendingMills: 40n, transactionCount: 2, fanCount: 2 });
    expect(sumHubLinkMoney(result.allocations, { pageId: PAGE, linkKind: "trial", linkRef: "2", fromAt: t(0), toAt: t(24) }))
      .toEqual({ netMills: 500n, pendingMills: 40n, transactionCount: 1, fanCount: 1 });
  });

  it("conserves money: for every transaction, its shares plus its unallocated part equal its amount", () => {
    // Deterministic pseudo-random ledger over overlapping periods.
    let seed = 20261009;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const links = ["10573270", "10802699", "11170786", "11170787", "11687581"];
    const periods: HubLinkPeriod[] = [];
    for (let fan = 1; fan <= 40; fan += 1) {
      for (const ref of links) {
        if (random(3) === 0) continue;
        const start = random(4) === 0 ? null : random(200);
        const end = random(3) === 0 ? null : (start ?? 0) + 1 + random(200);
        periods.push(period(ref, fan, start, end));
      }
    }
    const transactions = Array.from({ length: 2000 }, () =>
      tx(1 + random(40), random(400), BigInt(random(200_001) - 50_000), random(5) === 0 ? { state: "pending" } : {}));
    const result = attributeHubLinkMoney({
      floors: floors(links.map((ref) => [ref, random(50)])),
      periods,
      transactions,
    });
    for (const transaction of transactions) {
      const allocated = result.allocations
        .filter((row) => row.transactionId === transaction.id)
        .reduce((sum, row) => sum + row.mills, 0n);
      const left = result.unallocated
        .filter((row) => row.transactionId === transaction.id)
        .reduce((sum, row) => sum + row.mills, 0n);
      expect(allocated + left, `transaction ${transaction.id}`).toBe(transaction.netMills);
      // Never both: a transaction is split or left whole.
      expect(allocated !== 0n && left !== 0n).toBe(false);
    }
    // The split did happen (the test is not vacuous).
    expect(new Set(result.allocations.map((row) => row.transactionId)).size).toBeGreaterThan(500);
    expect(result.allocations.length).toBeGreaterThan(new Set(result.allocations.map((row) => row.transactionId)).size);
  });
});
