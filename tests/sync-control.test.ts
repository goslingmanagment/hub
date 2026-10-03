import { describe, expect, it } from "vitest";

import { syncTriggerBodySchema } from "@agency_hub_core/contracts";

import {
  filterStreamsForSyncConfig,
  requestAllPagesSync,
  resolveStreamsForScope,
} from "../apps/runtime/src/services/sync-control.ts";
import { FANSLY_ENGINE_SCOPE_STREAMS } from "../apps/runtime/src/services/sync-engine-levers.ts";

describe("resolveStreamsForScope", () => {
  it("exposes posts as an explicit one-stream scope on both platforms", () => {
    // A Fansly page's scopes are the engine levers' since step 4 (S4-10).
    expect(FANSLY_ENGINE_SCOPE_STREAMS.posts).toEqual(["posts"]);
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

  it("resolves no Fansly scope: the legacy executor serves no Fansly page (step 4 S4-10)", () => {
    for (const scope of ["light", "followers", "all", "data", "messages", "posts"] as const) {
      expect(() => resolveStreamsForScope("fansly", scope)).toThrow(`${scope} sync is not supported for fansly pages`);
    }
  });

  it("treats follower reconcile as part of Fansly data sync", () => {
    expect(FANSLY_ENGINE_SCOPE_STREAMS.data).toEqual([
      "light",
      "transactions",
      "top_spenders",
      "subscribers",
      "followers",
      "followers_reconcile",
    ]);
  });

  it("keeps Fansly history while permanently excluding legacy OnlyFans history", () => {
    expect(FANSLY_ENGINE_SCOPE_STREAMS.messages).toEqual([
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
  });
});
