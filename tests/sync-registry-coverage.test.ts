import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SYNC_STREAMS } from "@agency_hub_core/db";
import { FANSLY_SEND_SOURCES, FANSLY_WIRE_SPECS } from "@agency_hub_core/fansly";

import { beforeGateKeys, NOT_IMPLEMENTED_RECHECK_MS, plansBeforeGate, pollsFor } from "../apps/runtime/src/sync/engine/resource.ts";
import {
  createFanslyRegistry,
  FANSLY_LEGACY_UNMAPPED,
  FANSLY_LIVE_FRAME_RESOURCE,
  FANSLY_RESOURCE_SPECS,
  fanslyNewPageKeys,
  fanslyNewPageWork,
  fanslyResourceSpec,
  type LegacyRef,
  type ResourceSpec,
  type Trigger,
} from "../apps/runtime/src/sync/fansly/registry.ts";
import { ownerEnqueueKeys } from "../apps/runtime/src/sync/inspect.ts";
import { routeHoldAfter } from "../apps/runtime/src/sync/engine/route-holds.ts";
import { RouteClocks, routeExclusions } from "../apps/runtime/src/sync/engine/route-policy.ts";
import { DM_LIST_READ_KEYS, DM_LIST_WS_DOWN_EVERY_MS } from "../apps/runtime/src/sync/fansly/resources/dm-conversations.ts";
import type { FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";
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
    // The legacy executor ran every stream of the vocabulary on a Fansly page
    // but the OnlyFans-only `fan_identities`, which carries a disposition.
    const fanslyStreams = SYNC_STREAMS;
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

  it("names only known wire routes", () => {
    const ids = new Set(Object.keys(FANSLY_WIRE_SPECS));
    for (const spec of FANSLY_RESOURCE_SPECS) {
      for (const operation of spec.operations) expect(ids.has(operation), `${spec.key}: ${operation}`).toBe(true);
      if (spec.http) {
        expect(spec.operations.length > 0 || spec.key === "probe.manual", spec.key).toBe(true);
      }
    }
  });

  it("the conversation list's follow-ups are triggers of the entries they create (design §5.3)", () => {
    // A list read asks for a chat's messages (urgent from find and ws-down,
    // planned from head, full and detail — urgent from them too for a chat a
    // `.find` is open for, step 3b) and a group detail; no account probe since
    // a lookup miss excludes no chat (arena "vanished chat" §6).
    expect(byKey("dm-messages.head").triggers).toEqual(expect.arrayContaining([
      "apply:dm-conversations.find", "apply:dm-conversations.ws-down",
      "apply:dm-conversations.head", "apply:dm-conversations.full", "apply:dm-conversations.detail",
    ]));
    expect(byKey("dm-messages.catchup").triggers).toEqual(expect.arrayContaining([
      "apply:dm-conversations.head", "apply:dm-conversations.full", "apply:dm-conversations.detail",
    ]));
    expect(byKey("dm-conversations.detail").triggers).toEqual(["apply:dm-conversations.*"]);
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
      const clocks = new RouteClocks({ sends: [], state: { routes: { [route]: hold.entry } } });
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

  it("owner-protected, evidence and fence sets of design §2.9 and §4.4", () => {
    const keys = (predicate: (spec: ResourceSpec) => boolean) => FANSLY_RESOURCE_SPECS.filter(predicate).map((spec) => spec.key).sort();
    expect(keys((spec) => spec.ownerProtected === true)).toEqual(["catalog.fixed", "catalog.vault", "media-stats.walk"]);
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
    expect(beforeGateKeys(registry, page)).toEqual(["dm-live.deletions", "dm-conversations.find"]);
    // The owner's pause and switch of a key hold there as in every pick.
    expect(beforeGateKeys(registry, { ...page, pausedResources: ["dm-conversations.find"] })).toEqual(["dm-live.deletions"]);
    expect(beforeGateKeys(registry, { ...page, registryOverrides: { "dm-live.deletions": { enabled: false } } }))
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

  it("a cadence is a schedule something keeps: the vault's standing walk, and the list read its own module re-arms while the socket is down", () => {
    expect(FANSLY_RESOURCE_SPECS.filter((entry) => entry.cadence !== undefined).map((entry) => entry.key))
      .toEqual(["dm-conversations.ws-down", "catalog.vault"]);
    expect(byKey("catalog.vault").standing).toBeDefined();
    expect(byKey("dm-conversations.ws-down").cadence).toEqual({ everyMs: DM_LIST_WS_DOWN_EVERY_MS });
  });

  it("the vault walk stands over the projected album list, re-checked daily (design §5.17, owner decision №6)", () => {
    const standing = FANSLY_RESOURCE_SPECS.filter((spec) => spec.standing !== undefined && spec.subjectQueue !== true);
    expect(standing.map((spec) => [spec.key, spec.kind, spec.standing!.recheckMs])).toEqual([["catalog.vault", "goal", 86_400_000]]);
    expect(fanslyResourceSpec("catalog.vault")!.ownerProtected).toBe(true);
  });
});

describe("every trigger an entry declares has its producer", () => {
  // A trigger is a promise: something creates or bumps the key's work for it.
  // Each (key, trigger) pair of the registry is owned by exactly one producer
  // — a file and a marker the file holds: the call that writes the work (for
  // a derived category the call site, never membership in a list the
  // registry itself builds). Socket frames (`ws:*`) are the router's: its own
  // suite proves every declared pair is emitted by some frame
  // (tests/sync-ws-router.test.ts). An entry nothing triggers is drain-only:
  // it runs rows an older image left, and says so here.
  const root = join(__dirname, "..");
  const SRC = "apps/runtime/src";

  interface Producer {
    file: string;
    marker: string;
  }

  /** Keys with no trigger: the rows an older image asked for still run. */
  const DRAIN_ONLY: Readonly<Record<string, string>> = {
    "fan-profiles.probe": "a lookup miss excludes no chat (arena \"vanished chat\" §6): no apply of this build asks for it",
  };

  const lookup = (file: string): Producer => ({ file, marker: "lookupFollowups(" });
  const dmListFollowups: Producer = { file: `${SRC}/sync/fansly/resources/dm-conversations.ts`, marker: "list_head:${input.key}" };
  const repair = (marker: string): Producer => ({ file: `${SRC}/sync/fansly/resources/repair.ts`, marker });
  const transactions = (marker: string): Producer => ({ file: `${SRC}/sync/fansly/resources/transactions.ts`, marker });
  /** The pairs no derived category owns, each with its producer. */
  const EXPLICIT: ReadonlyArray<{ key: string; trigger: Trigger } & Producer> = [
    // The socket's lifecycle and its gap repair.
    { key: "ws.connect", trigger: "ws_lifecycle", file: `${SRC}/sync/fansly/ws/source.ts`, marker: 'resource: "ws.connect"' },
    { key: "dm-conversations.ws-down", trigger: "ws_lifecycle", file: `${SRC}/sync/fansly/ws/source.ts`, marker: '"dm-conversations.ws-down"' },
    { key: "repair.ws-gap", trigger: "ws_gap", file: `${SRC}/sync/fansly/ws/source.ts`, marker: '"repair.ws-gap"' },
    { key: "dm-messages.head", trigger: "ws_gap", ...repair("applyListPage(") },
    { key: "transactions.head", trigger: "ws_gap", ...repair("resource: MONEY_HEAD_KEY") },
    { key: "subscribers.poll", trigger: "ws_gap", ...repair("resource: SUBSCRIBERS_KEY") },
    // A plan that waits for another key's work.
    { key: "account.poll", trigger: "dependency", file: `${SRC}/sync/fansly/lib/page-facts.ts`, marker: 'resource: "account.poll"' },
    {
      key: "dm-conversations.find", trigger: "dependency",
      file: `${SRC}/sync/fansly/resources/dm-messages.ts`, marker: "resource: FIND_KEY, subject: groupId, demand: { reason: `dependency:",
    },
    { key: "transactions.backfill", trigger: "dependency", ...transactions('resource: "transactions.backfill"') },
    // An apply's follow-ups.
    { key: "dm-conversations.detail", trigger: "apply:dm-conversations.*", file: `${SRC}/sync/fansly/resources/dm-conversations.ts`, marker: "resource: DETAIL_KEY" },
    ...(["ws-down", "find", "head", "full", "detail"] as const).map((variant) => ({
      key: "dm-messages.head", trigger: `apply:dm-conversations.${variant}` as Trigger, ...dmListFollowups,
    })),
    ...(["head", "full", "detail"] as const).map((variant) => ({
      key: "dm-messages.catchup", trigger: `apply:dm-conversations.${variant}` as Trigger, ...dmListFollowups,
    })),
    { key: "transactions.rescan", trigger: "apply:transactions.head", ...transactions('resource: "transactions.rescan"') },
    // The roster has no standing row: the money steps ask for it when a
    // subject is dirty (projection queue) or past its age (poll-like).
    { key: "fan-earnings.roster", trigger: "projection_queue", ...transactions("fanEarningsRosterFollowups(") },
    { key: "fan-earnings.roster", trigger: "poll", ...transactions("fanEarningsRosterFollowups(") },
    { key: "fan-earnings.roster", trigger: "apply:transactions.*", ...transactions("fanEarningsRosterFollowups(") },
    { key: "purchases.targets", trigger: "apply:transactions.*", ...transactions("purchaseTargetFollowups(") },
    { key: "purchases.targets", trigger: "apply:dm-messages.*", file: `${SRC}/sync/fansly/resources/dm-messages.ts`, marker: "purchaseTargetFollowups(" },
    { key: "payouts.walk", trigger: "apply:payouts.daily", file: `${SRC}/sync/fansly/resources/payouts.ts`, marker: "resource: PAYOUTS_WALK_KEY" },
    { key: "followers.reconcile", trigger: "apply:followers.head", file: `${SRC}/sync/fansly/resources/followers.ts`, marker: "resource: RECONCILE_KEY" },
    { key: "fan-profiles.lookup", trigger: "apply:subscribers.*", ...lookup(`${SRC}/sync/fansly/resources/subscribers.ts`) },
    { key: "fan-profiles.lookup", trigger: "apply:followers.*", ...lookup(`${SRC}/sync/fansly/resources/followers.ts`) },
    { key: "fan-profiles.lookup", trigger: "apply:transactions.*", ...lookup(`${SRC}/sync/fansly/resources/transactions.ts`) },
    { key: "post-replies.authors", trigger: "apply:post-replies.walk", file: `${SRC}/sync/fansly/resources/post-replies.ts`, marker: "resource: AUTHORS_KEY" },
    { key: "catalog.vault", trigger: "apply:catalog.fixed", file: `${SRC}/sync/fansly/resources/catalog.ts`, marker: "resource: VAULT_KEY" },
    { key: "catalog.hydrate", trigger: "apply:catalog.*", file: `${SRC}/sync/fansly/resources/catalog.ts`, marker: "resource: HYDRATE_KEY" },
  ];

  const ownerKeys = new Set(ownerEnqueueKeys());
  const standingKeys = new Set(pollsFor(createFanslyRegistry(), { registryOverrides: {} }).map((row) => row.resource));
  const ACCOUNT_CHECKS = ["account.verify", "account.identity"];

  /** Every producer that owns the pair (exactly one is the rule). */
  function producersOf(key: string, trigger: Trigger): Producer[] {
    const found: Producer[] = [];
    if (trigger === "new_page") found.push({ file: `${SRC}/services/page-onboarding.ts`, marker: "fanslyNewPageWork(" });
    if (trigger === "owner" && ownerKeys.has(key)) found.push({ file: `${SRC}/sync/cli.ts`, marker: "enqueueOwnerSyncWork(" });
    if (trigger === "owner" && key === "probe.manual") found.push({ file: `${SRC}/sync/inspect.ts`, marker: "PROBE_KEY" });
    if (trigger === "owner" && key === "probe.excluded-chat") found.push({ file: `${SRC}/sync/excluded.ts`, marker: "EXCLUDED_CHAT_PROBE_KEY" });
    if ((trigger === "owner" || trigger === "api") && ACCOUNT_CHECKS.includes(key)) {
      found.push({ file: `${SRC}/services/sync-engine-account.ts`, marker: `resource: "${key}"` });
    }
    if (trigger === "api" && !ACCOUNT_CHECKS.includes(key)) found.push({ file: `${SRC}/sync/requests/urgent.ts`, marker: "apiResourceSpec(" });
    if (trigger === "request") found.push({ file: `${SRC}/sync/requests/history.ts`, marker: "HISTORY_WORK_RESOURCE" });
    if ((trigger === "poll" || trigger === "projection_queue") && standingKeys.has(key)) {
      found.push({ file: `${SRC}/sync/engine/actor.ts`, marker: "ensurePollRows(" });
    }
    if (trigger.startsWith("ws:")) found.push({ file: `${SRC}/sync/fansly/ws/router.ts`, marker: "export function routeWsItems(" });
    for (const row of EXPLICIT) {
      if (row.key === key && row.trigger === trigger) found.push({ file: row.file, marker: row.marker });
    }
    return found;
  }

  const pairs = FANSLY_RESOURCE_SPECS.flatMap((spec) => spec.triggers.map((trigger) => ({ key: spec.key, trigger })));

  it("each (key, trigger) pair has exactly one producer, and the producer's file holds its marker", () => {
    expect(pairs.length).toBeGreaterThan(50);
    const sources = new Map<string, string>();
    const source = (file: string) => {
      if (!sources.has(file)) sources.set(file, readFileSync(join(root, file), "utf8"));
      return sources.get(file)!;
    };
    const unowned: string[] = [];
    for (const { key, trigger } of pairs) {
      const producers = producersOf(key, trigger);
      if (producers.length !== 1) {
        unowned.push(`${key}|${trigger}: ${producers.length} producers`);
        continue;
      }
      const [producer] = producers;
      if (!source(producer!.file).includes(producer!.marker)) unowned.push(`${key}|${trigger}: no "${producer!.marker}" in ${producer!.file}`);
    }
    expect(unowned).toEqual([]);
  });

  it("the explicit table names declared pairs only, each once (both ways)", () => {
    const declared = new Set(pairs.map((pair) => `${pair.key}|${pair.trigger}`));
    const listed = EXPLICIT.map((row) => `${row.key}|${row.trigger}`);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.filter((pair) => !declared.has(pair))).toEqual([]);
    // Every pair of the explicit kinds is in it (the categories above own none of them).
    const explicitKinds = pairs.filter(({ key, trigger }) =>
      trigger === "ws_gap" || trigger === "ws_lifecycle" || trigger === "dependency" || trigger.startsWith("apply:") ||
      ((trigger === "poll" || trigger === "projection_queue") && !standingKeys.has(key)));
    expect(explicitKinds.map((pair) => `${pair.key}|${pair.trigger}`).sort()).toEqual([...listed].sort());
    // The live frame overlay is no work row: not an entry, no producer.
    expect(FANSLY_RESOURCE_SPECS.some((spec) => spec.key === FANSLY_LIVE_FRAME_RESOURCE.key)).toBe(false);
  });

  it("an entry nothing triggers is drain-only, with its reason", () => {
    const untriggered = FANSLY_RESOURCE_SPECS.filter((spec) => spec.triggers.length === 0).map((spec) => spec.key);
    expect(untriggered).toEqual(Object.keys(DRAIN_ONLY));
    for (const reason of Object.values(DRAIN_ONLY)) expect(reason.length).toBeGreaterThan(10);
  });

  it("a page's birth queues its five history walks, page-level planned goals — no top-spenders bootstrap, no DM history (owner decisions)", () => {
    expect(fanslyNewPageKeys()).toEqual([
      "notifications.backfill", "posts.backfill", "stats.backfill", "subscribers.history", "transactions.backfill",
    ]);
    for (const key of fanslyNewPageKeys()) {
      expect(byKey(key), key).toMatchObject({ kind: "goal", class: "planned", subject: "page" });
      // The owner can start each one again.
      expect(byKey(key).triggers, key).toContain("owner");
    }
    const now = new Date("2026-10-10T12:00:00Z");
    expect(fanslyNewPageWork({ pageId: 7, now })).toEqual(fanslyNewPageKeys().map((resource) => ({
      pageId: 7, resource, subject: "", kind: "goal", class: "planned", dueAt: now, coalesceUntil: null, deadlineAt: null,
      extendOnSignal: false, demand: { messageIds: [], txIds: [], reasons: ["new_page"] },
    })));
    // A key that declares the trigger must be one walk of the page.
    const perThread = { ...byKey("dm-messages.history"), triggers: ["new_page"] as Trigger[] };
    expect(() => fanslyNewPageWork({ pageId: 7, now }, [perThread])).toThrow(/page-level goals only/);
  });
});

describe("the shadow report and the questions it asked the resources are gone (step 4, S4-22)", () => {
  const root = join(__dirname, "..");
  // The deletion's proof, kept true: none of these names anywhere in the
  // sources or the tests. Spelled in halves so this file is no hit itself.
  const QUESTIONS = [
    ["estimate", "RunSteps"],
    ["dueAt", "Look"],
    ["queueNext", "DueAt"],
  ].map(([head, tail]) => `${head}${tail}`);
  const GONE = [
    ...QUESTIONS,
    ...[
      ["Replay", "Verdict"],
      ["shadowReport", "Check"],
      ["buildShadow", "Report"],
      ["listLegacyWsHint", "MembershipPending"],
      ["listFanslyWsExact", "DeletedMessageRefs"],
    ].map(([head, tail]) => `${head}${tail}`),
  ];

  it.each(GONE)("%s names nothing in apps, packages or tests", (name) => {
    let hits = "";
    try {
      hits = execFileSync(
        "grep",
        ["-rlF", name, "--exclude-dir=node_modules", "--exclude-dir=dist", "--exclude-dir=.vite", "apps", "packages", "tests"],
        { cwd: root, encoding: "utf8" },
      );
    } catch {
      // grep exits 1 when nothing matches.
    }
    expect(hits.split("\n").filter(Boolean)).toEqual([]);
  });

  it("its files and the database's side of it are gone; the alerts keep their commands", () => {
    for (const path of [
      "apps/runtime/src/sync/report",
      "apps/runtime/src/sync/cli/report.ts",
      "apps/runtime/src/sync/fansly/lib/family-replay.ts",
      "apps/runtime/src/sync/fansly/lib/replay-rules.ts",
      "packages/db/src/repositories/fansly-ws-hints.ts",
    ]) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
    const repositories = readdirSync(join(root, "packages/db/src/repositories"), { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".ts"))
      .map((path) => readFileSync(join(root, "packages/db/src/repositories", path), "utf8"))
      .join("\n");
    for (const name of [
      "readLegacyDmStoredWindow", "listStoredDmMessagesForReplay", "readLegacyMessageArrivals",
      "listLegacyPurchaseHistoryCapturesInWindow", "listPpvLedgerSales", "listSyncReplayObservations",
      "countSyncAttemptsByKey", "listSyncRunAttempts", "readSyncPollPlacements", "readSyncClosedRuns", "listSyncWorkOpenAt",
      "listSyncAdmissions", "listSharedReadAdmissions", "readFirstShadowAdmissions", "countLegacyFanslyAttempts",
    ]) {
      expect(repositories, name).not.toContain(name);
    }
    const cli = readFileSync(join(root, "apps/runtime/src/cli.ts"), "utf8");
    expect(cli).toContain("registerSyncAlertsCommands(sync);");
    expect(cli).not.toMatch(/registerSyncReportCommands|shadow report/);
  });

  it("no module answers a report question or replays a legacy observation", async () => {
    const registry = createFanslyRegistry();
    for (const spec of FANSLY_RESOURCE_SPECS) {
      const module = await registry.module(spec.key) as unknown as Record<string, unknown>;
      for (const hook of [...QUESTIONS, "replay"]) expect(module[hook], `${spec.key}: ${hook}`).toBeUndefined();
      expect("replayKinds" in spec, spec.key).toBe(false);
    }
  });
});

describe("shadow mode is gone (step 4, S4-23)", () => {
  const root = join(__dirname, "..");
  // The deletion's proof, kept true: none of these names anywhere in the
  // sources or the tests. Spelled in halves so this file is no hit itself.
  const GONE = [
    ["engine/", "shadow"],
    ["Shadow", "Transport"],
    ["Shadow", "Context"],
    ["Shadow", "Result"],
    ["Shadow", "Feed"],
    ["Shadow", "WsFeed"],
    ["Shadow", "Pass"],
    ["Shadow", "Visit"],
    ["Shadow", "Walk"],
    ["Shadow", "StatusView"],
    ["Shadow", "Latency"],
    ["settle", "Shadow"],
    ["plan", "Shadow"],
    ["route", "ShadowReceipts"],
    ["shadow", "Feed"],
    ["shadow", "Latency"],
    ["shadow", "Visit"],
    ["shadow", "After"],
    ["shadow", "Step"],
    ["statusJournal", "IsShadow"],
    ["sync_", "shadow_"],
    ["SHADOW_", "WS_"],
    ["ctx.", "shadow"],
    ["live", "Only"],
    ["runs", "In("],
    ["advance", "WsRouterCursor"],
    ["listWsRouter", "Receipts"],
    ["wsRouterHorizon", "Watermark"],
    ["OwnBroadcast", "Window"],
    ["SubjectQueue", "Keyset"],
  ].map(([head, tail]) => `${head}${tail}`);

  it.each(GONE)("%s names nothing in apps, packages or tests", (name) => {
    let hits = "";
    try {
      hits = execFileSync(
        "grep",
        ["-rlF", name, "--exclude-dir=node_modules", "--exclude-dir=dist", "--exclude-dir=.vite", "apps", "packages", "tests"],
        { cwd: root, encoding: "utf8" },
      );
    } catch {
      // grep exits 1 when nothing matches.
    }
    expect(hits.split("\n").filter(Boolean)).toEqual([]);
  });

  it("its transport and its own suites are gone", () => {
    for (const path of [
      join("apps/runtime/src/sync/engine", "shadow.ts"),
      "tests/sync-shadow.integration.test.ts",
      "tests/sync-ws-router.integration.test.ts",
    ]) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
  });

  it("no module has a shadow step, no entry is kept out of a mode, and a request names no shadow position", async () => {
    const registry = createFanslyRegistry();
    for (const spec of FANSLY_RESOURCE_SPECS) {
      const module = await registry.module(spec.key) as unknown as Record<string, unknown>;
      expect(module.shadow, spec.key).toBeUndefined();
      expect(`${"live"}Only` in spec, spec.key).toBe(false);
    }
    const contract = readFileSync(join(root, "apps/runtime/src/sync/engine/resource.ts"), "utf8");
    expect(contract).not.toMatch(/\bshadow\b/i);
    expect(contract).not.toMatch(/\bposition\??:/);
  });

  it("the queue writes `shadow` false, the journal leaves the column to its default, and no reader is told which journal to read", () => {
    const sources = (dir: string) => readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".ts"))
      .map((path) => [join(dir, path), readFileSync(join(root, dir, path), "utf8")] as const);
    const inserts: string[] = [];
    for (const [path, source] of [...sources("packages/db/src/repositories"), ...sources("apps/runtime/src")]) {
      // No input selects a journal and nothing binds the column to a value.
      expect(source, path).not.toMatch(/input\.shadow|options\.shadow|\bshadow\s*=\s*\$\{/);
      for (const match of source.matchAll(/insert into (sync_work|sync_attempts) \(([^)]*)\)\s*select ([^\n]*)/g)) {
        inserts.push(`${match[1]}(${match[2]!.replace(/\s+/g, " ").trim()}) ${match[3]!.trim()}`);
      }
    }
    // The only writers of the two tables: demand, the standing rows, an admission.
    expect(inserts).toHaveLength(3);
    const [demand, standing] = inserts.filter((insert) => insert.startsWith("sync_work("));
    for (const insert of [demand!, standing!]) {
      expect(insert).toMatch(/^sync_work\(page_id, shadow, resource, subject, /);
      expect(insert).toContain("${input.pageId}::bigint, false, ");
    }
    const [admission] = inserts.filter((insert) => insert.startsWith("sync_attempts("));
    expect(admission).not.toMatch(/\bshadow\b/);
  });
});
