import { describe, expect, it } from "vitest";

import { walkOnlyfansVaultListPages, type OnlyfansVaultListsPage } from "../apps/runtime/src/services/publications-onlyfans-reads.ts";

// The walk is complete only when it reached the end; cut short, it still
// returns what it saw, so «missing» is never concluded from it.

const list = (id: number) => ({ id, name: `Album ${id}`, type: "custom", canUpdate: true, mediaCount: 2 });
const pages = (...answers: Array<OnlyfansVaultListsPage | Omit<Extract<OnlyfansVaultListsPage, { ok: true }>, "intentId">>) => {
  let index = 0;
  return async (): Promise<OnlyfansVaultListsPage> => ({ intentId: `i${index}`, ...answers[index++]! } as OnlyfansVaultListsPage);
};

describe("walkOnlyfansVaultListPages", () => {
  it("is complete when a page says there is no more", async () => {
    const walk = await walkOnlyfansVaultListPages(pages({ ok: true, list: [list(1), list(2)], hasMore: true }, { ok: true, list: [list(3)], hasMore: false }));
    expect(walk).toMatchObject({ complete: true, reason: null, requests: 2 });
    expect(walk.lists.map((item) => item.id)).toEqual(["1", "2", "3"]);
  });

  it("is cut short by a failed page, the request budget, or a list seen twice, keeping what it saw", async () => {
    const failed = await walkOnlyfansVaultListPages(pages({ ok: true, list: [list(1)], hasMore: true }, { ok: false, reason: "vendor_http_500", intentId: "x" }));
    expect(failed).toMatchObject({ complete: false, reason: "vendor_http_500", requests: 2 });
    expect(failed.lists.map((item) => item.id)).toEqual(["1"]);

    const budget = await walkOnlyfansVaultListPages(pages({ ok: true, list: [list(1)], hasMore: true }, { ok: true, list: [list(2)], hasMore: true }), 2);
    expect(budget).toMatchObject({ complete: false, reason: "read_budget", requests: 2 });

    const moved = await walkOnlyfansVaultListPages(pages({ ok: true, list: [list(1), list(2)], hasMore: true }, { ok: true, list: [list(2)], hasMore: false }));
    expect(moved).toMatchObject({ complete: false, reason: "order_moved" });
  });
});
