import { describe, expect, it } from "vitest";

import { getSyncStreamsForPlatform } from "@agency_hub_core/db";
import { FANSLY_SEND_SOURCES, fanslyWireSpec, FANSLY_WIRE_SPECS, type FanslyWireId } from "@agency_hub_core/fansly";

import { beforeGateKeys, NOT_IMPLEMENTED_RECHECK_MS, plansBeforeGate } from "../apps/runtime/src/sync/engine/resource.ts";
import {
  createFanslyRegistry,
  FANSLY_LEGACY_UNMAPPED,
  FANSLY_RESOURCE_SPECS,
  fanslyReplayOwner,
  fanslyResourceSpec,
  type LegacyRef,
  type ResourceSpec,
} from "../apps/runtime/src/sync/fansly/registry.ts";
import { routeHoldAfter } from "../apps/runtime/src/sync/engine/route-holds.ts";
import { RouteClocks, routeExclusions, ROUTE_STATE_VERSION } from "../apps/runtime/src/sync/engine/route-policy.ts";
import { DM_LIST_READ_KEYS } from "../apps/runtime/src/sync/fansly/resources/dm-conversations.ts";
import type { FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";
import { isQueueWalk, QUEUE_WALK_DRIVERS, ratePeriodMs, runGroupingOf } from "../apps/runtime/src/sync/report/shadow-window.ts";
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
        expect(spec.operations.length > 0 || spec.key === "probe.manual", spec.key).toBe(true);
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
    expect(fanslyReplayOwner("dm_conversations")?.key).toBe("dm-conversations.head");
    expect(fanslyReplayOwner("group_detail")?.key).toBe("dm-conversations.find");
  });

  it("the conversation list's follow-ups are triggers of the entries they create (design §5.3)", () => {
    // A list read asks for a chat's messages (urgent from find and ws-down,
    // planned from head, full and detail — urgent from them too for a chat a
    // `.find` is open for, step 3b), a group detail, a probe.
    expect(byKey("dm-messages.head").triggers).toEqual(expect.arrayContaining([
      "apply:dm-conversations.find", "apply:dm-conversations.ws-down",
      "apply:dm-conversations.head", "apply:dm-conversations.full", "apply:dm-conversations.detail",
    ]));
    expect(byKey("dm-messages.catchup").triggers).toEqual(expect.arrayContaining([
      "apply:dm-conversations.head", "apply:dm-conversations.full", "apply:dm-conversations.detail",
    ]));
    expect(byKey("dm-conversations.detail").triggers).toEqual(["apply:dm-conversations.*"]);
    expect(byKey("fan-profiles.probe").triggers).toEqual(expect.arrayContaining(["apply:dm-conversations.*"]));
    for (const key of ["dm-conversations.head", "dm-conversations.full"]) expect(byKey(key).kind, key).toBe("poll");
    expect(byKey("dm-conversations.full").period?.everyMs).toBe(86_400_000);
    expect(byKey("dm-conversations.head").period?.everyMs).toBe(30 * 60_000);
  });

  it("a `.find`'s shared list-head read may be any key of the list route, and its closure is a local step (step 3b, plan PR 1-3)", async () => {
    // Every key that reads the list writes each page through the list's
    // writer: an applied read of the head by any of them answers a find.
    const listReaders = FANSLY_RESOURCE_SPECS.filter((spec) => spec.operations.includes("messaging.groups")).map((spec) => spec.key);
    expect([...DM_LIST_READ_KEYS].sort()).toEqual(listReaders.sort());
    expect(plansBeforeGate(byKey("dm-conversations.find"))).toBe(true);
    expect(typeof (await createFanslyRegistry().module("dm-conversations.find")).applyLocal).toBe("function");
  });

  it("a route's 429 leaves out exactly the keys all of whose routes it holds (owner decisions №14, №20 → №22)", () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const heldOnly = (route: FanslyRoute): string[] => {
      const hold = routeHoldAfter({ route, entry: null, now, httpStatus: 429, retryAfterMs: 60_000, attemptId: 1, jitter: () => 0 })!;
      const clocks = new RouteClocks({ sends: [], state: { version: ROUTE_STATE_VERSION, routes: { [route]: hold.entry } } });
      return routeExclusions(FANSLY_RESOURCE_SPECS, clocks, now);
    };
    const onlyReading = (route: FanslyRoute) => FANSLY_RESOURCE_SPECS
      .filter((spec) => spec.operations.length > 0 && spec.operations.every((operation) => operation === route))
      .map((spec) => spec.key)
      .sort();
    // The list: the keys that can only read it; `.find` reads it too, but goes
    // on through the group detail.
    expect(heldOnly("messaging.groups")).toEqual(onlyReading("messaging.groups"));
    expect(heldOnly("messaging.groups")).toEqual(["dm-conversations.full", "dm-conversations.head", "dm-conversations.ws-down", "repair.ws-gap"]);
    expect(byKey("dm-conversations.find").operations).toEqual(["messaging.groups", "group.detail"]);
    // The media statistics: the walk alone; every wire route on the endpoint is that one route.
    const onEndpoint = Object.values(FANSLY_WIRE_SPECS)
      .filter((spec) => spec.endpointTemplate === FANSLY_WIRE_SPECS["media.offer_stats"].endpointTemplate)
      .map((spec) => spec.id);
    expect(onEndpoint).toEqual(["media.offer_stats"]);
    expect(heldOnly("media.offer_stats")).toEqual(["media-stats.walk"]);
    // Live confirmations: the head read's route held leaves out the keys of that route only.
    expect(heldOnly("messages.page")).toEqual(onlyReading("messages.page"));
  });

  it("I12: a history walk only on a request", () => {
    const history = byKey("dm-messages.history");
    expect(history.triggers).toEqual(["request"]);
    expect(history.class).toBe("requests");
    expect(history.kind).toBe("goal");
    expect(FANSLY_RESOURCE_SPECS.filter((spec) => spec.class === "requests").map((spec) => spec.key)).toEqual(["dm-messages.history"]);
  });

  it("only the keys whose 401/403 is never the page session's scope them to the subject (G16, E8)", async () => {
    const scoped = FANSLY_RESOURCE_SPECS.filter((spec) => spec.subjectScopedAuthStatuses !== undefined)
      .map((spec) => [spec.key, spec.subjectScopedAuthStatuses]);
    // A CDN hop carries no session: its 401/403 is the signed URL's; an
    // identity check carries a candidate: its 401/403 is the candidate's
    // (S3-05); an excluded chat may be forbidden while the session is fine
    // (S3-06) — its 401 stays the page's.
    expect(scoped).toEqual([
      ["account.identity", [401, 403]],
      ["media-download.fetch", [401, 403]],
      ["probe.excluded-chat", [403]],
    ]);
    expect(byKey("ws.connect").operations).toEqual(["ws.upgrade"]);
    expect(byKey("media-download.fetch").operations).toEqual(["cdn.media"]);
    expect(byKey("repair.ws-gap").operations).toEqual(["messaging.groups"]);
    const registry = createFanslyRegistry();
    for (const key of ["ws.connect", "media-download.fetch"]) {
      // Their answers are never journaled: applied from memory.
      expect(typeof (await registry.module(key)).applyAnswer, key).toBe("function");
      expect(typeof (await registry.module(key)).outcome, key).toBe("function");
    }
    expect(typeof (await registry.module("repair.ws-gap")).applyLocal).toBe("function");
  });

  it("owner-protected, live-only, evidence and fence sets of design §2.9 and §4.4", () => {
    const keys = (predicate: (spec: ResourceSpec) => boolean) => FANSLY_RESOURCE_SPECS.filter(predicate).map((spec) => spec.key).sort();
    expect(keys((spec) => spec.ownerProtected === true)).toEqual(["catalog.fixed", "catalog.vault", "media-stats.walk"]);
    expect(keys((spec) => spec.liveOnly === true)).toEqual([
      "account.identity", "dm-conversations.ws-down", "media-download.fetch", "probe.excluded-chat", "repair.ws-gap", "ws.connect",
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

  it("ruling 9: the keys whose due work is planned before the HTTP gate — those without HTTP first", () => {
    const registry = createFanslyRegistry();
    const page = { pausedResources: [] as string[], registryOverrides: {} };
    expect(FANSLY_RESOURCE_SPECS.filter((spec) => spec.planBeforeGate === true).map((spec) => spec.key)).toEqual(["dm-conversations.find"]);
    for (const shadow of [false, true]) {
      expect(beforeGateKeys(registry, page, shadow)).toEqual(["dm-live.deletions", "dm-conversations.find"]);
    }
    // The owner's pause and switch of a key hold there as in every pick.
    expect(beforeGateKeys(registry, { ...page, pausedResources: ["dm-conversations.find"] }, false)).toEqual(["dm-live.deletions"]);
    expect(beforeGateKeys(registry, { ...page, registryOverrides: { "dm-live.deletions": { enabled: false } } }, false))
      .toEqual(["dm-conversations.find"]);
    // Never a history read (I12): those wait for a request and their slot.
    expect(FANSLY_RESOURCE_SPECS.filter(plansBeforeGate).every((spec) => spec.class !== "requests")).toBe(true);
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

  it("S2-07a/b ship the audience and money resources, S2-08a/b dm-conversations and dm-messages, S2-09a/b the content resources, S2-10 dm-live, S3-04 the live-only ones; no entry waits on missing code", async () => {
    const implemented = FANSLY_RESOURCE_SPECS.filter((spec) => spec.module !== undefined).map((spec) => spec.file);
    expect([...new Set(implemented)].sort()).toEqual([
      "account", "catalog", "dm-conversations", "dm-live", "dm-messages", "fan-earnings", "fan-profiles", "followers",
      "media-download", "media-stats", "notifications", "payouts", "post-replies", "posts", "probe", "purchases", "repair",
      "stats", "subscribers", "top-spenders", "transactions", "ws",
    ]);
    expect(FANSLY_RESOURCE_SPECS.filter((spec) => spec.module === undefined).map((spec) => spec.key)).toEqual([]);
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

  it("the implemented entries replay and import what design §5.1, §5.3, §5.4, §5.6–§5.13 say", async () => {
    const registry = createFanslyRegistry();
    for (const key of [
      "account.poll", "subscribers.poll", "followers.head", "fan-profiles.lookup", "dm-conversations.head",
      "dm-conversations.find", "dm-messages.head", "transactions.head", "top-spenders.window", "fan-earnings.roster",
      "purchases.targets", "payouts.daily",
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
    const standing = FANSLY_RESOURCE_SPECS.filter((spec) => spec.standing !== undefined && spec.subjectQueue === true);
    expect(standing.map((spec) => spec.key).sort()).toEqual(["media-stats.walk", "post-replies.walk", "posts.engagement"]);
    for (const spec of standing) {
      expect(spec.kind, spec.key).toBe("goal");
      expect(spec.standing!.recheckMs, spec.key).toBe(6 * 3_600_000);
      expect(typeof (await createFanslyRegistry().module(spec.key)).onSubjectOutcome, spec.key).toBe("function");
    }
  });

  it("only the owner-protected walks take a page override of their cadence or tiers (owner decision №6)", () => {
    const overridable = FANSLY_RESOURCE_SPECS.filter((spec) => spec.pageOverride !== undefined);
    expect(overridable.map((spec) => [spec.key, spec.pageOverride])).toEqual([["catalog.vault", "cadence"], ["media-stats.walk", "tiers"]]);
    for (const spec of overridable) {
      expect(spec.ownerProtected, spec.key).toBe(true);
      expect(spec.pageOverride === "cadence" ? spec.cadence : spec.tiers, spec.key).toBeDefined();
    }
  });

  it("a cadence is a schedule the engine keeps: only on a subject-queue walk or a standing walk", () => {
    for (const spec of FANSLY_RESOURCE_SPECS.filter((entry) => entry.cadence !== undefined && entry.liveOnly !== true)) {
      expect(spec.subjectQueue === true || spec.standing !== undefined, spec.key).toBe(true);
    }
  });

  it("the shadow report can judge every key it counts at a rate or by a schedule (rules A1.rate-assumed, A1.floor-queue, A1.floor-idle)", async () => {
    const registry = createFanslyRegistry();
    const page = { registryOverrides: {} };
    // Every key on a period longer than the report's hour: a single request,
    // or a module that estimates its run.
    const rated = FANSLY_RESOURCE_SPECS.filter((spec) => spec.liveOnly !== true && ratePeriodMs(spec, page, 3_600_000) !== null);
    expect(rated.map((spec) => spec.key).sort()).toEqual([
      "catalog.fixed", "dm-conversations.full", "followers.reconcile", "payouts.daily", "posts.refresh", "stats.daily", "stats.hourly",
      "top-spenders.window",
    ]);
    for (const spec of rated) {
      const module = await registry.module(spec.key);
      expect(runGroupingOf(spec) === "single" || typeof module.estimateRunSteps === "function", spec.key).toBe(true);
    }
    // Every standing walk re-runs its look; every queue walk reads its queue
    // and is asked for by a poll.
    for (const spec of FANSLY_RESOURCE_SPECS.filter((entry) => entry.standing !== undefined)) {
      expect(typeof (await registry.module(spec.key)).dueAtLook, spec.key).toBe("function");
    }
    for (const spec of FANSLY_RESOURCE_SPECS.filter(isQueueWalk)) {
      expect(typeof (await registry.module(spec.key)).queueNextDueAt, spec.key).toBe("function");
      expect(QUEUE_WALK_DRIVERS[spec.key]?.length, spec.key).toBeGreaterThan(0);
      for (const driver of QUEUE_WALK_DRIVERS[spec.key]!) expect(byKey(driver).kind, driver).toBe("poll");
    }
  });

  it("the vault walk stands over the projected album list, re-checked daily (design §5.17, owner decision №6)", () => {
    const standing = FANSLY_RESOURCE_SPECS.filter((spec) => spec.standing !== undefined && spec.subjectQueue !== true);
    expect(standing.map((spec) => [spec.key, spec.kind, spec.standing!.recheckMs])).toEqual([["catalog.vault", "goal", 86_400_000]]);
    expect(fanslyResourceSpec("catalog.vault")!.ownerProtected).toBe(true);
  });

  it("the content-b entries replay their kinds and import their legacy cursors (design §5.17–§5.19, §5.22)", async () => {
    const registry = createFanslyRegistry();
    for (const key of ["catalog.fixed", "catalog.vault", "catalog.hydrate", "media-stats.walk", "stats.daily"]) {
      expect(typeof (await registry.module(key)).replay, key).toBe("function");
    }
    for (const key of ["catalog.fixed", "catalog.vault", "media-stats.walk", "stats.daily", "stats.hourly", "stats.backfill"]) {
      expect(typeof (await registry.module(key)).importLegacy, key).toBe("function");
    }
    for (const kind of ["vault_albums", "uservault_albums", "subscription_tiers", "gift_codes", "automated_messages", "account_walls"]) {
      expect(fanslyReplayOwner(kind)?.key, kind).toBe("catalog.fixed");
    }
    expect(fanslyReplayOwner("vault_media")?.key).toBe("catalog.vault");
    expect(fanslyReplayOwner("account_media_batch")?.key).toBe("catalog.hydrate");
    expect(fanslyReplayOwner("media_offer_stats")?.key).toBe("media-stats.walk");
    for (const kind of ["account_stats", "earnings_stats_snapshot", "discovery_feed", "broadcast_stats_deleted", "recapstats"]) {
      expect(fanslyReplayOwner(kind)?.key, kind).toBe("stats.daily");
    }
  });
});
