// WP-F5 — the reply-page walk's pure rules (`sync/fansly/lib/post-replies-rules.ts`),
// which the engine's post-replies resource reads. No database.

import { describe, expect, it } from "vitest";

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

  it("computes p99 by nearest rank, and null on no samples", () => {
    expect(p99PostsLength([])).toBeNull();
    expect(p99PostsLength([1])).toBe(1);
    expect(p99PostsLength([1, 1, 1, 1, 9])).toBe(9);
  });
});
