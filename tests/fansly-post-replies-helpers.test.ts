// WP-F5 — the reply-page walk's pure helpers. No database: the queue, paging,
// coverage and attempt invariants that need one stay in
// fansly-post-replies-lane.integration.test.ts.

import { describe, expect, it } from "vitest";

import { hasAccountSidecar, replyAuthorRefs } from "../apps/runtime/src/services/sync/fansly-post-replies.ts";
import {
  nextRepliesCursor,
  p99PostsLength,
  replyRows,
} from "../apps/runtime/src/sync/fansly/lib/post-replies-rules.ts";

describe("WP-F5 reply-page helpers", () => {
  it("tells an unreadable body from an EMPTY one", () => {
    // The distinction the whole archive rests on: `null` is "refuse", `[]` is
    // "this post has no comments", and confusing them either loses comments or
    // deletes them.
    expect(replyRows({ posts: [] })).toEqual([]);
    expect(replyRows({ __empty: true, httpStatus: 204 })).toEqual([]);
    expect(replyRows({ data: [] })).toBeNull();
    expect(replyRows(null)).toBeNull();
    expect(replyRows("nope")).toBeNull();
  });

  it("takes the cursor from the LAST row's own id", () => {
    expect(nextRepliesCursor([{ id: "a" }, { id: "b" }])).toBe("b");
    expect(nextRepliesCursor([])).toBeNull();
    expect(nextRepliesCursor([{ mediaOfferId: "x" }])).toBeNull();
  });

  it("de-duplicates author refs in order", () => {
    expect(replyAuthorRefs([
      { accountId: "a" },
      { accountId: "b" },
      { accountId: "a" },
      {},
    ])).toEqual(["a", "b"]);
  });

  it("knows whether the sidecar was populated", () => {
    expect(hasAccountSidecar({ accounts: [{ id: "a" }] })).toBe(true);
    // EMPTY in 2 of 5 live responses — the fact that makes the hydration
    // fallback mandatory rather than an optimization.
    expect(hasAccountSidecar({ accounts: [] })).toBe(false);
    expect(hasAccountSidecar({})).toBe(false);
  });

  it("computes p99 by nearest rank, and null on no samples", () => {
    expect(p99PostsLength([])).toBeNull();
    expect(p99PostsLength([1])).toBe(1);
    expect(p99PostsLength([1, 1, 1, 1, 9])).toBe(9);
  });
});
