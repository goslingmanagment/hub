import { describe, expect, it } from "vitest";

import { getSyncStreamsForPlatform } from "@agency_hub_core/db";
import { FANSLY_SEND_SOURCES, fanslyWireSpec, FANSLY_WIRE_SPECS, type FanslyWireId } from "@agency_hub_core/fansly";

import { NOT_IMPLEMENTED_RECHECK_MS } from "../apps/runtime/src/sync/engine/resource.ts";
import {
  createFanslyRegistry,
  FANSLY_LEGACY_UNMAPPED,
  FANSLY_RESOURCE_SPECS,
  fanslyReplayOwner,
  type LegacyRef,
  type ResourceSpec,
} from "../apps/runtime/src/sync/fansly/registry.ts";
import { RecordingMetrics } from "./helpers/sync-engine-host.ts";

// The Fansly registry (design §4.4, §4.5): every legacy stream of a Fansly
// page and every legacy sender (maps/senders.md §3, the send guard's closed
// `source` vocabulary) is taken over by at least one entry or carries an
// explicit disposition with its reason — "ни один ключ не удаляется молча".

const NOW = new Date("2026-10-02T12:00:00Z");

function refKey(ref: LegacyRef): string {
  return "stream" in ref ? `stream:${ref.stream}` : `sender:${ref.sender}`;
}

function byKey(key: string): ResourceSpec {
  const spec = FANSLY_RESOURCE_SPECS.find((entry) => entry.key === key);
  if (spec === undefined) throw new Error(`no registry entry ${key}`);
  return spec;
}

const mapped = new Set(FANSLY_RESOURCE_SPECS.flatMap((spec) => spec.legacy.map(refKey)));
const unmapped = new Map(FANSLY_LEGACY_UNMAPPED.map((entry) => [refKey(entry.ref), entry] as const));

describe("the Fansly registry covers every legacy stream and sender", () => {
  it("every Fansly stream maps to an entry or a disposition", () => {
    const fanslyStreams = getSyncStreamsForPlatform("fansly");
    expect(fanslyStreams.length).toBeGreaterThan(0);
    for (const name of fanslyStreams) {
      const key = `stream:${name}`;
      expect(mapped.has(key) || unmapped.has(key), `${name} has no entry and no disposition`).toBe(true);
    }
  });

  it("every legacy sender maps to an entry or a disposition", () => {
    for (const source of FANSLY_SEND_SOURCES) {
      const key = `sender:${source}`;
      expect(mapped.has(key) || unmapped.has(key), `${source} has no entry and no disposition`).toBe(true);
    }
  });

  it("a disposition is never also a mapping, and always says why", () => {
    for (const [key, entry] of unmapped) {
      expect(mapped.has(key), `${key} is both mapped and unmapped`).toBe(false);
      expect(entry.reason.length).toBeGreaterThan(10);
    }
    // The stream chunks are covered stream by stream: every stream must be.
    expect(unmapped.get("sender:sync_stream")?.disposition).toBe("by_streams");
  });

  it("the legacy matrix of design §4.5", () => {
    const keysFor = (ref: string) => FANSLY_RESOURCE_SPECS.filter((spec) => spec.legacy.map(refKey).includes(ref)).map((spec) => spec.key);
    expect(keysFor("stream:light")).toEqual(["account.poll"]);
    expect(keysFor("stream:subscribers")).toEqual(expect.arrayContaining(["subscribers.poll", "subscribers.history"]));
    expect(keysFor("stream:followers")).toEqual(expect.arrayContaining(["followers.head"]));
    expect(keysFor("stream:followers_reconcile")).toEqual(expect.arrayContaining(["followers.reconcile"]));
    expect(keysFor("stream:transactions")).toEqual([
      "transactions.head", "transactions.insurance", "transactions.rescan", "transactions.backfill",
    ]);
    expect(keysFor("stream:dm_messages")).toEqual(expect.arrayContaining(["dm-messages.head", "dm-messages.catchup", "dm-messages.history"]));
    expect(keysFor("sender:targeted_backfill")).toEqual(["dm-messages.history"]);
    expect(keysFor("sender:alias_backfill")).toEqual(["fan-profiles.alias-backfill"]);
    expect(keysFor("sender:binding_preflight")).toEqual(["account.identity"]);
    expect(keysFor("sender:ws_connect")).toEqual(["ws.connect"]);
    expect(keysFor("sender:media_download")).toEqual(["media-download.fetch"]);
    expect(keysFor("sender:endpoint_probe")).toEqual(["probe.manual"]);
  });
});

describe("the Fansly registry table", () => {
  it("builds: keys well formed and unique, every poll with a period", () => {
    expect(() => createFanslyRegistry()).not.toThrow();
    const keys = FANSLY_RESOURCE_SPECS.map((spec) => spec.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const spec of FANSLY_RESOURCE_SPECS) {
      expect(spec.key.split(".")[0], spec.key).toBe(spec.file);
    }
  });

  it("names only known wire routes, and every replayed kind is one its routes journal", () => {
    const ids = new Set(Object.keys(FANSLY_WIRE_SPECS));
    for (const spec of FANSLY_RESOURCE_SPECS) {
      for (const operation of spec.operations) expect(ids.has(operation), `${spec.key}: ${operation}`).toBe(true);
      const kinds = new Set(spec.operations.map((operation: FanslyWireId) => fanslyWireSpec(operation).kind));
      for (const kind of spec.replayKinds ?? []) expect(kinds.has(kind), `${spec.key} replays ${kind}`).toBe(true);
      if (spec.http) {
        expect(spec.operations.length > 0 || ["ws.connect", "media-download.fetch", "probe.manual"].includes(spec.key), spec.key).toBe(true);
      }
    }
  });

  it("one replay owner per observation kind", () => {
    const owners = new Map<string, string[]>();
    for (const spec of FANSLY_RESOURCE_SPECS) {
      for (const kind of spec.replayKinds ?? []) owners.set(kind, [...(owners.get(kind) ?? []), spec.key]);
    }
    for (const [kind, keys] of owners) expect(keys, kind).toHaveLength(1);
    expect(fanslyReplayOwner("account_me")?.key).toBe("account.poll");
    expect(fanslyReplayOwner("subscribers")?.key).toBe("subscribers.poll");
    expect(fanslyReplayOwner("followers")?.key).toBe("followers.head");
    expect(fanslyReplayOwner("account_lookup")?.key).toBe("fan-profiles.lookup");
  });

  it("I12: a history walk only on a request", () => {
    const history = byKey("dm-messages.history");
    expect(history.triggers).toEqual(["request"]);
    expect(history.class).toBe("requests");
    expect(history.kind).toBe("goal");
    expect(FANSLY_RESOURCE_SPECS.filter((spec) => spec.class === "requests").map((spec) => spec.key)).toEqual(["dm-messages.history"]);
  });

  it("owner-protected, live-only, evidence and fence sets of design §2.9 and §4.4", () => {
    const keys = (predicate: (spec: ResourceSpec) => boolean) => FANSLY_RESOURCE_SPECS.filter(predicate).map((spec) => spec.key).sort();
    expect(keys((spec) => spec.ownerProtected === true)).toEqual(["catalog.fixed", "catalog.vault", "media-stats.walk"]);
    expect(keys((spec) => spec.liveOnly === true)).toEqual([
      "account.identity", "dm-conversations.ws-down", "media-download.fetch", "repair.ws-gap", "ws.connect",
    ]);
    expect(keys((spec) => spec.evidence)).toEqual([
      "catalog.vault", "dm-messages.catchup", "dm-messages.head", "dm-messages.history",
      "notifications.backfill", "notifications.forward", "post-replies.walk", "purchases.targets",
    ]);
    for (const spec of FANSLY_RESOURCE_SPECS.filter((entry) => entry.file === "transactions" || entry.file.startsWith("dm-"))) {
      expect(spec.fence, spec.key).toBe("dm_archive");
    }
    expect(keys((spec) => !spec.http)).toEqual(["dm-live.deletions"]);
  });

  it("the owner's frequencies (decision №5, №6) and the stated-empty bound on account.poll", () => {
    expect(byKey("transactions.insurance").period?.everyMs).toBe(5 * 60_000);
    expect(byKey("catalog.fixed").period?.everyMs).toBe(24 * 3_600_000);
    expect(byKey("media-stats.walk").tiers).toEqual([
      { maxAgeDays: 30, everyMs: 86_400_000 },
      { maxAgeDays: 90, everyMs: 7 * 86_400_000 },
      { maxAgeDays: null, everyMs: 30 * 86_400_000 },
    ]);
    expect(byKey("notifications.forward").period?.everyMs).toBe(30 * 60_000);
    // The subscribers stated-empty rule needs the counter within 2 h.
    expect(byKey("account.poll").period!.everyMs * 1.1).toBeLessThanOrEqual(2 * 3_600_000);
    expect(byKey("followers.reconcile").minIntervalMs).toBe(86_400_000);
    // A standing poll row exists only where a poll is meant to run always.
    expect(byKey("dm-conversations.ws-down").kind).not.toBe("poll");
  });

  it("S2-07a/b ship the audience and money resources, S2-09a the content resources, S2-10 dm-live; every other entry waits on its dependency", async () => {
    const implemented = FANSLY_RESOURCE_SPECS.filter((spec) => spec.module !== undefined).map((spec) => spec.file);
    expect([...new Set(implemented)].sort()).toEqual([
      "account", "dm-live", "fan-earnings", "fan-profiles", "followers", "notifications", "payouts", "post-replies",
      "posts", "purchases", "subscribers", "top-spenders", "transactions",
    ]);
    const metrics = new RecordingMetrics();
    const registry = createFanslyRegistry({ metrics });
    for (const spec of FANSLY_RESOURCE_SPECS) {
      const module = await registry.module(spec.key);
      expect(typeof module.plan, spec.key).toBe("function");
      if (spec.module !== undefined) continue;
      const plan = await module.plan({} as never, { now: NOW } as never);
      expect(plan, spec.key).toEqual({ kind: "wait", reason: "dependency", until: new Date(NOW.getTime() + NOT_IMPLEMENTED_RECHECK_MS) });
    }
    expect(metrics.get("sync_not_implemented")).toBe(FANSLY_RESOURCE_SPECS.filter((spec) => spec.module === undefined).length);
  });

  it("the implemented entries replay and import what design §5.1, §5.6–§5.13 say", async () => {
    const registry = createFanslyRegistry();
    for (const key of [
      "account.poll", "subscribers.poll", "followers.head", "fan-profiles.lookup",
      "transactions.head", "top-spenders.window", "fan-earnings.roster", "purchases.targets", "payouts.daily",
    ]) {
      expect(typeof (await registry.module(key)).replay, key).toBe("function");
    }
    for (const key of [
      "followers.head", "followers.reconcile", "transactions.rescan", "top-spenders.bootstrap", "purchases.targets",
      "payouts.daily",
    ]) {
      expect(typeof (await registry.module(key)).importLegacy, key).toBe("function");
    }
    // Every money kind has its replay owner (design §3.12 B5).
    expect(fanslyReplayOwner("earnings_transactions")?.key).toBe("transactions.head");
    expect(fanslyReplayOwner("earnings_accounts")?.key).toBe("top-spenders.window");
    expect(fanslyReplayOwner("fan_earnings_monthly")?.key).toBe("fan-earnings.roster");
    expect(fanslyReplayOwner("purchase_history")?.key).toBe("purchases.targets");
    expect(fanslyReplayOwner("payout_requests")?.key).toBe("payouts.daily");
  });

  it("the money entries: one walk row per purchase target, the earnings roster a queue walk, the 5-min insurance poll", () => {
    const targets = byKey("purchases.targets");
    expect(targets).toMatchObject({ subject: "target", kind: "goal", terminalStatuses: [404, 410, 422] });
    expect(targets.subjectQueue).toBeUndefined();
    const roster = byKey("fan-earnings.roster");
    expect(roster).toMatchObject({ subjectQueue: true, terminalStatuses: [400, 404, 410], kind: "goal" });
    expect(roster.triggers).toContain("apply:transactions.*");
    expect(byKey("transactions.rescan").triggers).toContain("apply:transactions.head");
    expect(byKey("top-spenders.window").period?.everyMs).toBe(6 * 3_600_000);
    expect(byKey("payouts.daily").operations).toEqual(["payouts.methods", "payouts.requests"]);
  });

  it("the content entries replay their kinds and import their legacy cursors (design §5.14–§5.16)", async () => {
    const registry = createFanslyRegistry();
    for (const key of ["notifications.forward", "posts.refresh", "post-replies.walk"]) {
      expect(typeof (await registry.module(key)).replay, key).toBe("function");
    }
    for (const key of [
      "notifications.forward", "notifications.backfill", "posts.refresh", "posts.backfill", "posts.engagement", "post-replies.walk",
    ]) {
      expect(typeof (await registry.module(key)).importLegacy, key).toBe("function");
    }
    expect(fanslyReplayOwner("notifications")?.key).toBe("notifications.forward");
    expect(fanslyReplayOwner("posts")?.key).toBe("posts.refresh");
    expect(fanslyReplayOwner("post_tips")?.key).toBe("posts.refresh");
    expect(fanslyReplayOwner("post_replies")?.key).toBe("post-replies.walk");
  });

  it("the subject-queue walks over projector-fed queues are standing goals with a queue breaker (design §4.3)", async () => {
    const standing = FANSLY_RESOURCE_SPECS.filter((spec) => spec.standing !== undefined);
    expect(standing.map((spec) => spec.key).sort()).toEqual(["post-replies.walk", "posts.engagement"]);
    for (const spec of standing) {
      expect(spec.kind, spec.key).toBe("goal");
      expect(spec.subjectQueue, spec.key).toBe(true);
      expect(spec.standing!.recheckMs, spec.key).toBe(6 * 3_600_000);
      expect(typeof (await createFanslyRegistry().module(spec.key)).onSubjectOutcome, spec.key).toBe("function");
    }
  });
});
