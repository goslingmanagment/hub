import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FANSLY_WIRE_SPECS } from "@agency_hub_core/fansly";

import { plansBeforeGate, pollsFor } from "../apps/runtime/src/sync/engine/resource.ts";
import {
  createFanslyRegistry,
  FANSLY_RESOURCE_SPECS,
  fanslyNewPageKeys,
  fanslyNewPageWork,
  type ResourceSpec,
  type Trigger,
} from "../apps/runtime/src/sync/fansly/registry.ts";
import { ownerEnqueueKeys } from "../apps/runtime/src/sync/inspect.ts";
import { routeHoldAfter } from "../apps/runtime/src/sync/engine/route-holds.ts";
import { RouteClocks, routeExclusions } from "../apps/runtime/src/sync/engine/route-policy.ts";
import { DM_LIST_READ_KEYS } from "../apps/runtime/src/sync/fansly/resources/dm-conversations.ts";
import type { FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";

// The Fansly registry (design §4.4, §4.5): every legacy stream of a Fansly
// page and every legacy sender (maps/senders.md §3, the send guard's closed
// `source` vocabulary) is taken over by at least one entry or carries an
// explicit disposition with its reason — "ни один ключ не удаляется молча".

function byKey(key: string): ResourceSpec {
  const spec = FANSLY_RESOURCE_SPECS.find((entry) => entry.key === key);
  if (spec === undefined) throw new Error(`no registry entry ${key}`);
  return spec;
}

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
