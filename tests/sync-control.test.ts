import { describe, expect, it } from "vitest";

import { resolveStreamsForScope } from "../apps/runtime/src/services/sync-control.ts";

describe("resolveStreamsForScope", () => {
  it("treats follower reconcile as part of Fansly data sync", () => {
    expect(resolveStreamsForScope("fansly", "data")).toEqual([
      "light",
      "transactions",
      "top_spenders",
      "subscribers",
      "followers",
      "followers_reconcile",
    ]);
  });

  it("supports message sync for both Fansly and OnlyFans DM streams", () => {
    expect(resolveStreamsForScope("fansly", "messages")).toEqual([
      "dm_conversations",
      "dm_messages",
    ]);
    expect(resolveStreamsForScope("onlyfans", "data")).toEqual([
      "light",
      "transactions",
    ]);
    expect(resolveStreamsForScope("onlyfans", "messages")).toEqual([
      "dm_conversations",
      "dm_messages",
    ]);
  });
});
