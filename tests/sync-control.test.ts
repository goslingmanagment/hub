import { describe, expect, it } from "vitest";

import { syncTriggerBodySchema } from "@agency_hub_core/contracts";

import {
  filterStreamsForSyncConfig,
  requestAllPagesSync,
  resolveStreamsForScope,
} from "../apps/runtime/src/services/sync-control.ts";

describe("resolveStreamsForScope", () => {
  it("exposes posts as an explicit one-stream scope on both platforms", () => {
    expect(resolveStreamsForScope("fansly", "posts")).toEqual(["posts"]);
    expect(resolveStreamsForScope("onlyfans", "posts")).toEqual(["posts"]);
    expect(syncTriggerBodySchema.parse({ pageLabel: "creator-1", scope: "posts" }))
      .toEqual({ pageLabel: "creator-1", scope: "posts" });
  });

  it("keeps posts activation per-page instead of exposing a fleet crawl", async () => {
    await expect(requestAllPagesSync({} as never, {} as never, {
      scope: "posts",
      reason: "manual",
    })).rejects.toThrow("posts sync scope is per-page only");
  });

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

  it("keeps Fansly history while permanently excluding legacy OnlyFans history", () => {
    expect(resolveStreamsForScope("fansly", "messages")).toEqual([
      "dm_conversations",
      "dm_messages",
    ]);
    expect(resolveStreamsForScope("onlyfans", "data")).toEqual([
      "light",
      "transactions",
      "fan_identities",
      "top_spenders",
      "subscribers",
    ]);
    expect(resolveStreamsForScope("onlyfans", "messages")).toEqual([
      "dm_conversations",
    ]);
  });

  it("filters OnlyFans DM polling streams unless explicitly enabled", () => {
    // The audience filter (filterOnlyFansAudienceStreams) strips "subscribers"
    // separately in requestPageSync; the DM filter leaves it alone.
    expect(
      filterStreamsForSyncConfig("onlyfans", resolveStreamsForScope("onlyfans", "all"), {
        onlyFansDmPollingEnabled: false,
      }),
    ).toEqual([
      "light",
      "transactions",
      "fan_identities",
      "top_spenders",
      "subscribers",
    ]);
    expect(
      filterStreamsForSyncConfig("onlyfans", resolveStreamsForScope("onlyfans", "messages"), {
        onlyFansDmPollingEnabled: false,
      }),
    ).toEqual([]);
    expect(
      filterStreamsForSyncConfig("onlyfans", resolveStreamsForScope("onlyfans", "messages"), {
        onlyFansDmPollingEnabled: true,
      }),
    ).toEqual([
      "dm_conversations",
    ]);
    expect(
      filterStreamsForSyncConfig("fansly", resolveStreamsForScope("fansly", "messages"), {
        onlyFansDmPollingEnabled: false,
      }),
    ).toEqual([
      "dm_conversations",
      "dm_messages",
    ]);
  });
});
