import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SYNC_STREAMS, type SyncStream } from "@agency_hub_core/db";

import {
  FANSLY_KEYS_WITHOUT_LEVER,
  FANSLY_LEVER_STREAMS,
  FANSLY_RESOURCE_SPECS,
  fanslyFilesForStreams,
  fanslyKeysForStreams,
  fanslyLeverStreams,
  fanslyStreamPollSeconds,
} from "../apps/runtime/src/sync/fansly/registry.ts";
import { FANSLY_ENGINE_SCOPE_STREAMS } from "../apps/runtime/src/services/sync-engine-levers.ts";
import { ENGINE_BLOCK_STREAMS, engineBlockStreams } from "../apps/runtime/src/services/sync-status-engine.ts";
import { SYNC_DOMAIN_BLOCKS } from "../apps/runtime/src/services/sync-status.ts";

// Step 4, S4-24: the lever map lives in the engine registry
// (`FANSLY_LEVER_STREAMS`). The owner's levers (the Settings block buttons,
// the "sync now" scopes) and the surfaces that describe a Fansly page stream
// by stream (the Settings blocks, the insights coverage, the top-spenders
// source) resolve a stream name to registry keys through it. Until S4-24 the
// same table was derived from the registry's `legacy` refs and copied into the
// database package for the `sync_streams` dataset; both went with the
// dataset's Fansly rows.

const ROOT = join(__dirname, "..");
const registryKeys = FANSLY_RESOURCE_SPECS.map((spec) => spec.key);

describe("the engine registry's lever map", () => {
  it("is the table the levers moved before it lived in the registry", () => {
    expect(FANSLY_LEVER_STREAMS.map((line) => [line.stream, [...line.keys]])).toEqual([
      ["light", ["account.poll"]],
      ["dm_conversations", [
        "dm-conversations.head", "dm-conversations.full", "dm-conversations.find", "dm-conversations.detail",
        "dm-conversations.ws-down", "dm-messages.catchup", "fan-profiles.probe",
      ]],
      ["dm_messages", ["dm-messages.head", "dm-messages.catchup", "dm-messages.history", "fan-profiles.probe"]],
      ["transactions", ["transactions.head", "transactions.insurance", "transactions.rescan", "transactions.backfill"]],
      ["top_spenders", ["top-spenders.window", "top-spenders.bootstrap"]],
      ["fan_earnings", ["fan-earnings.roster"]],
      ["purchase_history", ["purchases.targets"]],
      ["payouts", ["payouts.daily", "payouts.walk"]],
      ["subscribers", ["subscribers.poll", "subscribers.history", "fan-profiles.lookup"]],
      ["followers", ["followers.head", "fan-profiles.lookup"]],
      ["followers_reconcile", ["followers.reconcile", "fan-profiles.lookup"]],
      ["notifications", ["notifications.forward", "notifications.backfill"]],
      ["posts", ["posts.refresh", "posts.backfill", "posts.engagement"]],
      ["post_replies", ["post-replies.walk", "post-replies.authors"]],
      ["catalog", ["catalog.fixed", "catalog.vault", "catalog.hydrate"]],
      ["media_stats", ["media-stats.walk"]],
      ["stats_snapshot", ["stats.daily", "stats.hourly", "stats.backfill"]],
    ]);
  });

  it("names each stream once, by a sync_stream value, with registry keys in registry order", () => {
    const names = fanslyLeverStreams();
    expect(new Set(names).size).toBe(names.length);
    for (const line of FANSLY_LEVER_STREAMS) {
      expect(SYNC_STREAMS, line.stream).toContain(line.stream);
      expect(line.keys.length, line.stream).toBeGreaterThan(0);
      expect(new Set(line.keys).size, line.stream).toBe(line.keys.length);
      for (const key of line.keys) expect(registryKeys, `${line.stream} ← ${key}`).toContain(key);
      expect([...line.keys], line.stream).toEqual(registryKeys.filter((key) => line.keys.includes(key)));
      expect(fanslyKeysForStreams([line.stream]), line.stream).toEqual([...line.keys]);
    }
    // OnlyFans's own stream names no Fansly key.
    expect(names).not.toContain("fan_identities");
    expect(fanslyKeysForStreams(["fan_identities"])).toEqual([]);
  });

  it("places every registry key: under a lever stream, or in the list of keys without one", () => {
    const levered = new Set(FANSLY_LEVER_STREAMS.flatMap((line) => line.keys));
    expect(registryKeys.filter((key) => !levered.has(key))).toEqual([...FANSLY_KEYS_WITHOUT_LEVER]);
    expect([...FANSLY_KEYS_WITHOUT_LEVER]).toEqual([
      "account.verify", "account.identity", "ws.connect", "dm-live.deletions", "fan-profiles.alias-backfill",
      "media-download.fetch", "repair.ws-gap", "probe.manual", "probe.excluded-chat",
    ]);
  });

  it("resolves several streams to their keys once, in registry order, and to their resource files", () => {
    expect(fanslyKeysForStreams(["top_spenders"])).toEqual(["top-spenders.window", "top-spenders.bootstrap"]);
    expect(fanslyKeysForStreams(["followers_reconcile", "subscribers", "followers"])).toEqual([
      "subscribers.poll", "subscribers.history", "followers.head", "followers.reconcile", "fan-profiles.lookup",
    ]);
    expect(fanslyFilesForStreams(["transactions", "fan_identities", "top_spenders"])).toEqual(["top-spenders", "transactions"]);
    expect(fanslyFilesForStreams(["light"])).toEqual(["account"]);
    expect(fanslyFilesForStreams([])).toEqual([]);
  });

  it("reads a stream's cadence from its first poll key (0: no poll)", () => {
    const seconds = Object.fromEntries(fanslyLeverStreams().map((stream) => [stream, fanslyStreamPollSeconds(stream)]));
    expect(seconds).toEqual({
      light: 3_600,
      dm_conversations: 1_800,
      dm_messages: 0,
      transactions: 300,
      top_spenders: 21_600,
      fan_earnings: 0,
      purchase_history: 0,
      payouts: 86_400,
      subscribers: 3_600,
      followers: 3_600,
      followers_reconcile: 0,
      notifications: 1_800,
      posts: 21_600,
      post_replies: 0,
      catalog: 86_400,
      media_stats: 0,
      stats_snapshot: 86_400,
    });
  });
});

describe("the Settings blocks of a Fansly page", () => {
  it("show and move lever streams of the map, each in one block", () => {
    expect(Object.keys(ENGINE_BLOCK_STREAMS)).toEqual([...SYNC_DOMAIN_BLOCKS]);
    expect(ENGINE_BLOCK_STREAMS).toEqual({
      connection: [{ stream: "light", role: "primary" }],
      financials: [{ stream: "transactions", role: "primary" }, { stream: "top_spenders", role: "supporting" }],
      audience: [
        { stream: "subscribers", role: "primary" },
        { stream: "followers", role: "primary" },
        { stream: "followers_reconcile", role: "supporting" },
      ],
      messages_live: [{ stream: "dm_conversations", role: "primary" }],
      messages_history: [{ stream: "dm_messages", role: "primary" }],
    });
    const inBlocks = SYNC_DOMAIN_BLOCKS.flatMap((block) => engineBlockStreams(block));
    expect(new Set(inBlocks).size).toBe(inBlocks.length);
    for (const stream of inBlocks) expect(fanslyLeverStreams(), stream).toContain(stream);
    // Every block has a primary stream and keys for its buttons.
    for (const block of SYNC_DOMAIN_BLOCKS) {
      expect(ENGINE_BLOCK_STREAMS[block].some(({ role }) => role === "primary"), block).toBe(true);
      expect(fanslyKeysForStreams(engineBlockStreams(block)).length, block).toBeGreaterThan(0);
    }
  });
});

describe("the \"sync now\" scopes of a Fansly page", () => {
  it("name lever streams that resolve to keys and resource files", () => {
    for (const [scope, streams] of Object.entries(FANSLY_ENGINE_SCOPE_STREAMS)) {
      expect(streams.length, scope).toBeGreaterThan(0);
      for (const stream of streams) {
        expect(fanslyLeverStreams(), `${scope}/${stream}`).toContain(stream);
      }
      expect(fanslyFilesForStreams(streams), scope).not.toEqual([]);
    }
    expect(fanslyFilesForStreams(FANSLY_ENGINE_SCOPE_STREAMS.all)).toEqual([
      "account", "dm-conversations", "dm-messages", "fan-profiles", "followers", "subscribers", "top-spenders",
      "transactions",
    ]);
    expect(fanslyFilesForStreams(FANSLY_ENGINE_SCOPE_STREAMS.posts)).toEqual(["posts"]);
  });

  it("leave the bulk reads out of `all`, `data` and `messages`: a manual \"sync everything\" does not start them", () => {
    const bulk: SyncStream[] = [
      "fan_earnings", "purchase_history", "stats_snapshot", "notifications", "catalog", "post_replies", "payouts",
      "media_stats",
    ];
    for (const scope of ["all", "data", "messages"] as const) {
      for (const stream of bulk) expect(FANSLY_ENGINE_SCOPE_STREAMS[scope], `${scope}/${stream}`).not.toContain(stream);
    }
  });
});

describe("the legacy Fansly surfaces are gone (the deletion's proof, step 4 S4-24)", () => {
  // None of these names anywhere in the sources or the tests. Spelled in
  // halves so this file is no hit itself. The frozen client SDKs under
  // tests/fixtures keep the contract they were built against.
  const GONE = [
    ["legacy", "-streams"],
    ["fanslyLegacy", "StreamTable"],
    ["fanslyEngine", "LegacyStreams"],
    ["FANSLY_ENGINE_", "LEGACY_STREAMS"],
    ["fanslyEngineStream", "KeysValuesSql"],
    ["followerMax", "AgeMinutes"],
    ["follower_sync", "_missing"],
    ["follower_sync", "_stale"],
    ["coverage", "_degraded"],
    ["countConversationSync", "FailuresByAccount"],
    ["FANSLY_BULK", "_SYNC_STREAMS"],
    ["SYNC_STREAM_", "STARVED_PRIORITY"],
    ["starvedPageSync", "PrioritySql"],
    ["followersReconcile", "FloorWaitUntil"],
    ["BULK_ENRICHMENT", "_SYNC_STREAMS"],
    ["hasOpaqueAudience", "FollowerProgress"],
  ].map(([head, tail]) => `${head}${tail}`);

  it.each(GONE)("%s names nothing in apps, packages or tests", (name) => {
    let hits = "";
    try {
      hits = execFileSync(
        "grep",
        [
          "-rlF", name, "--exclude-dir=node_modules", "--exclude-dir=dist", "--exclude-dir=.vite",
          "--exclude-dir=client-sdks", "apps", "packages", "tests",
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
    } catch {
      // grep exits 1 when nothing matches.
    }
    expect(hits.split("\n").filter(Boolean)).toEqual([]);
  });

  it("the stream map has no module left, in the engine or in the database package", () => {
    const module = `${GONE[0]}.ts`;
    expect(existsSync(join(ROOT, "apps/runtime/src/sync/fansly", module))).toBe(false);
    expect(existsSync(join(ROOT, "packages/db/src/repositories/sync", module))).toBe(false);
  });

  it("the sync_streams dataset reads the legacy executor's rows only", () => {
    const source = readFileSync(join(ROOT, "packages/db/src/repositories/agent-dataset-map.ts"), "utf8");
    const dataset = source.slice(source.indexOf("const SYNC_STREAMS = `"), source.indexOf("// ── endpoints-cover (WP-S1) sources"));
    expect(dataset).toContain("from page_sync_states ss");
    expect(dataset).toContain("where p.platform::text in (${LEGACY_EXECUTOR_PLATFORMS_SQL})");
    expect(dataset).not.toContain("union all");
    expect(dataset).not.toMatch(/sync_pages|sync_work|sync_attempts/);
  });
});
