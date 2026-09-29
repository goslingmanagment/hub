// WP-F7 — the payout request-history wire shapes, shared by the DB-backed lane
// suite (fansly-payouts-lane.integration.test.ts) and its walk-helper unit
// suite (fansly-payouts-helpers.test.ts).

export const NOW = new Date("2026-08-22T09:00:00.000Z");

/** The live history: `total = 83`, page size 10, oldest 2025-06-23. */
export const LIVE_TOTAL = 83;
export const PAGE_SIZE = 10;
export const OLDEST_MS = Date.parse("2025-06-23T12:00:00.000Z");

export function ref(n: number): string {
  return `0009${String(10000000000000 + n).padStart(14, "0")}`;
}

/** One page of the request history at `offset`, shaped exactly as the wire is:
 *  `{total, data[]}`, ten rows until the last, `createdAt` descending. */
export function requestPage(offset: number, total = LIVE_TOTAL) {
  const remaining = Math.max(0, total - offset);
  const size = Math.min(PAGE_SIZE, remaining);
  const data = Array.from({ length: size }, (_unused, index) => {
    const row = offset + index;
    return {
      id: ref(20000 + row),
      accountId: "acct-payouts",
      amount: 131000 + row,
      payoutMethodId: ref(9001),
      // ONE CODE DEEP: every live row carried 8.
      status: 8,
      version: 1,
      // Descending, so the LAST row of the LAST page is the floor.
      createdAt: OLDEST_MS + (total - 1 - row) * 86_400_000,
      updatedAt: OLDEST_MS + (total - 1 - row) * 86_400_000 + 3_600_000,
    };
  });
  return { total, data };
}

/** The same history with ids that stay with their payout as new ones land at
 *  the head: the oldest payout is always `ref(20000)`, the newest
 *  `ref(20000 + total - 1)`. What a catch-up has to be able to recognise. */
export function stableRequestPage(offset: number, total: number) {
  const page = requestPage(offset, total);
  return {
    total,
    data: page.data.map((row, index) => ({
      ...row,
      id: ref(20000 + (total - 1 - (offset + index))),
    })),
  };
}
