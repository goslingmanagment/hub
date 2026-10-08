import { describe, expect, it } from "vitest";

import type { SyncWorkResourceCounts, SyncWorkRow } from "@agency_hub_core/db";
import { INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import {
  buildEngineDomainBlock,
  engineOwnerRunning,
  engineStops,
  engineStreamState,
  type EngineStatusFacts,
} from "../apps/runtime/src/services/sync-status-engine.ts";
import { SYNC_DOMAIN_BLOCKS } from "../apps/runtime/src/services/sync-status.ts";
import { fanslyKeysForStreams, fanslyLeverStreams, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { routeOfWireId, type FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";
import { pageHoldRow, resourceBreakerRow, routeHoldRows } from "./helpers/sync-holds.ts";

// One lever stream of an engine page as its surfaces read it (the Settings
// blocks, the analytics Coverage panel): what of it is open, why its earliest
// work waits — as data, for a surface that words it itself — and, when it
// needs the owner, the commands that really list that work (step 4, S4-34);
// and what stops its keys from sending now, by the owner's pauses and the
// engine's own hold evaluator (S4-35).

const NOW = new Date("2026-10-04T09:00:00.000Z");
const minutes = (n: number): Date => new Date(NOW.getTime() + n * 60_000);

function page(overrides: Record<string, unknown> = {}): EngineStatusFacts["page"] {
  return {
    pageId: 7,
    pageLabel: "lilly-1",
    mode: "live",
    pausedAll: false,
    pausedRequests: false,
    pausedResources: [],
    // The page's hold set (`sync_holds`): it holds nothing.
    holds: [],
    lastSendAt: minutes(-1),
    lastCompletedAt: minutes(-1),
    dbNow: NOW,
    // A host runs the page: a heartbeat a few seconds old.
    owner: {
      generation: 3n, host: "sync-1", acquiredAt: minutes(-60), heartbeatAt: new Date(NOW.getTime() - 5_000),
      releasedAt: null, releaseGeneration: null,
    },
    ...overrides,
  } as unknown as EngineStatusFacts["page"];
}

function counts(resource: string, overrides: Partial<SyncWorkResourceCounts> = {}): SyncWorkResourceCounts {
  return {
    pageId: 7, resource, active: 1, running: 0, quarantined: 0, blockedByVendor: 0, maxFailureCount: 0, nextDueAt: null,
    ...overrides,
  };
}

function row(resource: string, overrides: Record<string, unknown> = {}): SyncWorkRow {
  return {
    id: 1, resource, subject: "", class: "planned", state: "open", dueAt: minutes(30), breakerUntil: null,
    blockedByVendorAt: null, waitingReason: "not_due", waitingUntil: minutes(30),
    ...overrides,
  } as unknown as SyncWorkRow;
}

/** A page-level row as the final check before an admission leaves it when the
 *  route of its planned request is closed (`deferForRoute`): `pacer`, due
 *  when the route opens. */
function putOffRow(resource: string, until: Date, id = 1): SyncWorkRow {
  return row(resource, { id, dueAt: until, waitingReason: "pacer", waitingUntil: until });
}

/** The routes a registry key declares. */
function routesOf(key: string): FanslyRoute[] {
  return [...new Set((fanslyResourceSpec(key)?.operations ?? []).map(routeOfWireId))];
}

function facts(input: {
  page?: Record<string, unknown>;
  counts?: SyncWorkResourceCounts[];
  rows?: SyncWorkRow[];
  appliedAt?: Record<string, Date>;
  chatsUnavailable?: number;
} = {}): EngineStatusFacts {
  return {
    page: page(input.page),
    counts: new Map((input.counts ?? []).map((entry) => [entry.resource, entry])),
    pageRows: input.rows ?? [],
    appliedAt: new Map(Object.entries(input.appliedAt ?? {})),
    settingMs: 2500,
    ...(input.chatsUnavailable === undefined ? {} : { chatsUnavailable: input.chatsUnavailable }),
  };
}

describe("a lever stream of an engine page", () => {
  it("says why its earliest page-level work waits as data, and as one line for the API", () => {
    const state = engineStreamState("light", facts({
      counts: [counts("account.poll", { nextDueAt: minutes(30) })],
      rows: [row("account.poll")],
      appliedAt: { "account.poll": minutes(-30) },
    }));
    expect(state).toMatchObject({
      activeWork: 1,
      needsAttention: false,
      succeededAt: minutes(-30),
      nextDueAt: minutes(30),
      waiting: { resource: "account.poll", reason: "not_due", until: minutes(30) },
      statusReason: { code: "not_due", summary: `account.poll: not_due until ${minutes(30).toISOString()}` },
    });
  });

  it("counts the open work of every key and subject, and has nothing to explain when none is page-level", () => {
    const state = engineStreamState("dm_messages", facts({
      counts: [
        counts("dm-messages.head", { active: 2, running: 1, nextDueAt: minutes(-1) }),
        counts("dm-messages.history", { active: 40, nextDueAt: minutes(2) }),
      ],
      appliedAt: { "dm-messages.head": minutes(-4), "dm-messages.history": minutes(-2) },
    }));
    expect(state).toMatchObject({
      activeWork: 42,
      succeededAt: minutes(-2),
      nextDueAt: minutes(-1),
      waiting: null,
      statusReason: null,
    });
  });

  it("the messages block counts the chats Fansly does not serve, beside its state and never as attention", () => {
    // The chat's head row is out of the vendor's block count already
    // (`countActiveLiveWorkByResource`): what is left is the chat, counted.
    const chats = facts({ counts: [counts("dm-messages.head", { active: 1 })], chatsUnavailable: 2 });
    const messages = buildEngineDomainBlock("messages_history", chats);
    expect(messages).toMatchObject({ needsAttention: false, engine: { chatsUnavailable: 2, blockedByVendor: { count: 0, resources: [] } } });
    expect(messages.substreams.every((substream) => !substream.needsAttention)).toBe(true);
    // Only the block that reads the chats' messages counts them.
    expect(buildEngineDomainBlock("financials", chats).engine).not.toHaveProperty("chatsUnavailable");
    expect(buildEngineDomainBlock("messages_history", facts()).engine).toMatchObject({ chatsUnavailable: 0 });
  });

  it("a stream nothing asked for has no work and no read", () => {
    expect(engineStreamState("followers_reconcile", facts())).toMatchObject({
      activeWork: 0, succeededAt: null, nextDueAt: null, waiting: null, needsAttention: false,
    });
  });

  it("names the command that lists work Fansly refuses: it is open, not quarantined", () => {
    const state = engineStreamState("payouts", facts({
      counts: [counts("payouts.daily", { blockedByVendor: 1, maxFailureCount: 2 })],
      rows: [row("payouts.daily", { blockedByVendorAt: minutes(-180), breakerUntil: minutes(120) })],
    }));
    expect(state.needsAttention).toBe(true);
    expect(state.waiting).toBeNull();
    expect(state.statusReason).toEqual({
      code: "engine_blocked_by_vendor",
      summary: "1 blocked by Fansly (payouts.daily); "
        + "pnpm cli sync work list --page lilly-1 --state open --resource payouts.daily",
      waitingFor: null,
    });
    expect(state.statusReason!.summary).not.toContain("--state quarantined");
  });

  it("names the quarantine listing for quarantined work, and both when a stream has both", () => {
    const quarantined = engineStreamState("catalog", facts({
      counts: [counts("catalog.fixed", { quarantined: 1, maxFailureCount: 5 })],
    }));
    expect(quarantined.statusReason).toEqual({
      code: "engine_quarantined",
      summary: "1 quarantined (catalog.fixed); pnpm cli sync work list --page lilly-1 --state quarantined",
      waitingFor: null,
    });

    const both = engineStreamState("catalog", facts({
      counts: [
        counts("catalog.fixed", { quarantined: 1 }),
        counts("catalog.vault", { blockedByVendor: 2 }),
        counts("catalog.hydrate", { active: 3, blockedByVendor: 1 }),
      ],
    }));
    expect(both.statusReason!.summary).toBe(
      "1 quarantined (catalog.fixed), 3 blocked by Fansly (catalog.vault, catalog.hydrate); "
      + "pnpm cli sync work list --page lilly-1 --state quarantined; "
      + "pnpm cli sync work list --page lilly-1 --state open --resource catalog.vault; "
      + "pnpm cli sync work list --page lilly-1 --state open --resource catalog.hydrate",
    );
    expect(both.activeWork).toBe(5);
  });

  it("a hold with no end has no 'until'", () => {
    const state = engineStreamState("light", facts({
      page: { holds: [pageHoldRow("auth", INDEFINITE_UNTIL, { since: minutes(-10) })] },
      counts: [counts("account.poll", { nextDueAt: minutes(-1) })],
      rows: [row("account.poll", { dueAt: minutes(-1), waitingReason: null, waitingUntil: null })],
    }));
    expect(state.waiting).toEqual({ resource: "account.poll", reason: "page_hold", until: null });
    expect(state.statusReason!.summary).toBe("account.poll: page_hold");
  });
});

// S4-35: "reading" was what a surface said of any stream with open work,
// while the page was held for its credentials, the stream's only route by a
// 429, its file by a breaker, or the owner had paused it. What stops a
// stream's keys is the answer of the hold evaluator the actor admits by, key
// by key, with the owner's pauses before it.
describe("what stops the keys of a stream", () => {
  it("nothing stops a stream of a page that holds nothing", () => {
    for (const stream of fanslyLeverStreams()) {
      expect(engineStreamState(stream, facts()), stream).toMatchObject({ stopped: "none", stops: [], paused: false });
    }
  });

  it("refused credentials stop every key of every stream, with no end", () => {
    const held = facts({ page: { holds: [pageHoldRow("auth", INDEFINITE_UNTIL, { since: minutes(-10) })] } });
    for (const stream of fanslyLeverStreams()) {
      const state = engineStreamState(stream, held);
      expect(state.stopped, stream).toBe("all");
      expect(state.paused, stream).toBe(false);
      expect(state.stops, stream).toEqual([{ reason: "page_hold", by: ["auth"], resources: state.keys, until: null }]);
    }
  });

  it("a network hold stops every key until its end; one that ended stops nothing", () => {
    const state = engineStreamState("transactions", facts({ page: { holds: [pageHoldRow("network", minutes(3))] } }));
    expect(state.stops).toEqual([{ reason: "page_hold", by: ["network"], resources: state.keys, until: minutes(3) }]);
    expect(engineStreamState("transactions", facts({ page: { holds: [pageHoldRow("network", minutes(-1))] } })).stopped).toBe("none");
  });

  // A stream whose work is per chat has no page-level row to explain: the
  // verdict is about its keys, so it holds for it all the same.
  it("a 429's hold of a stream's only route stops it, whatever its work is per subject", () => {
    const held = facts({
      page: { holds: routeHoldRows("messages.page", { holdUntil: minutes(40).toISOString(), ladderStep: 3, revision: 4 }) },
      counts: [counts("dm-messages.head", { active: 2, nextDueAt: minutes(-1) }), counts("dm-messages.history", { active: 9, nextDueAt: minutes(-2) })],
    });
    const history = engineStreamState("dm_messages", held);
    expect(history.stopped).toBe("all");
    expect(history.stops).toEqual([{
      reason: "route_hold",
      by: ["messages.page"],
      resources: ["dm-messages.head", "dm-messages.catchup", "dm-messages.history"],
      until: minutes(40),
    }]);
    // Work that is open but held has no next read.
    expect(history).toMatchObject({ activeWork: 11, nextDueAt: null, waiting: null });
    // The chat list reads other routes: nothing of it is stopped.
    expect(engineStreamState("dm_conversations", held)).toMatchObject({ stopped: "none", stops: [] });
  });

  // A key that reads several routes is picked while one of them is open, so
  // a 429's hold of the route its request takes shows only on its row: the
  // final check before the admission puts it off until the route opens. Seen
  // in review: "Posts [reading]" and "Follower reconcile [reading]" above
  // "…: endpoint held (429) until …".
  it("a hold of one of a key's routes stops the key once it has put the key's work off, and nothing before", () => {
    const timelineHeld = { holds: routeHoldRows("posts.timeline", { holdUntil: minutes(40).toISOString() }) };
    // `posts.refresh` reads the timeline and the tips. Its work is due and
    // nothing has put it off: its next request may take the open route.
    const due = engineStreamState("posts", facts({
      page: timelineHeld,
      counts: [counts("posts.refresh", { nextDueAt: minutes(-1) })],
      rows: [row("posts.refresh", { dueAt: minutes(-1), waitingReason: null, waitingUntil: null })],
    }));
    expect(due).toMatchObject({ stopped: "none", stops: [], nextDueAt: minutes(-1) });
    // Neither does work that only waits for its schedule.
    expect(engineStreamState("posts", facts({
      page: timelineHeld, counts: [counts("posts.refresh", { nextDueAt: minutes(30) })], rows: [row("posts.refresh")],
    }))).toMatchObject({ stopped: "none", stops: [], waiting: { reason: "not_due" } });

    // The timeline's hold put the work of both timeline keys off; the stream's
    // third key reads another route.
    const held = engineStreamState("posts", facts({
      page: timelineHeld,
      counts: [
        counts("posts.refresh", { nextDueAt: minutes(40) }),
        counts("posts.backfill", { nextDueAt: minutes(40) }),
        counts("posts.engagement", { nextDueAt: minutes(5) }),
      ],
      rows: [
        putOffRow("posts.refresh", minutes(40)),
        putOffRow("posts.backfill", minutes(40), 2),
        row("posts.engagement", { id: 3, dueAt: minutes(5), waitingUntil: minutes(5) }),
      ],
    }));
    expect(held.stopped).toBe("some");
    expect(held.stops).toEqual([
      { reason: "route_hold", by: ["posts.timeline"], resources: ["posts.refresh", "posts.backfill"], until: minutes(40) },
    ]);
    // The next read is of the key nothing stops, and so is the wait explained.
    expect(held).toMatchObject({
      activeWork: 3, nextDueAt: minutes(5), waiting: { resource: "posts.engagement", reason: "not_due", until: minutes(5) },
    });

    // The follower reconcile walk after a 429 on the followers list (its
    // other route, the account read, is open): the stream's one open row.
    const walk = engineStreamState("followers_reconcile", facts({
      page: { holds: routeHoldRows("followers.page", { holdUntil: minutes(40).toISOString() }) },
      counts: [counts("followers.reconcile", { nextDueAt: minutes(40) })],
      rows: [putOffRow("followers.reconcile", minutes(40))],
    }));
    expect(walk.stops).toEqual([
      { reason: "route_hold", by: ["followers.page"], resources: ["followers.reconcile"], until: minutes(40) },
    ]);
    // The stop and the wait say the same thing of the row; it has no next read.
    expect(walk).toMatchObject({
      stopped: "some", nextDueAt: null, waiting: { resource: "followers.reconcile", reason: "route_hold", until: minutes(40) },
    });

    // A stream of one such key is held whole.
    const roster = engineStreamState("fan_earnings", facts({
      page: { holds: routeHoldRows("earnings.monthly_accounts", { holdUntil: minutes(40).toISOString() }) },
      counts: [counts("fan-earnings.roster", { nextDueAt: minutes(40) })],
      rows: [putOffRow("fan-earnings.roster", minutes(40))],
    }));
    expect(roster).toMatchObject({ stopped: "all", paused: false, nextDueAt: null });
    expect(roster.stops).toEqual([
      { reason: "route_hold", by: ["earnings.monthly_accounts"], resources: ["fan-earnings.roster"], until: minutes(40) },
    ]);
  });

  it("work a route put off is stopped only while a hold keeps a route of its key closed; a route's own pace is no stop", () => {
    // Put off for the route's pace: queued.
    const paced = engineStreamState("posts", facts({
      counts: [counts("posts.refresh", { nextDueAt: minutes(1) })], rows: [putOffRow("posts.refresh", minutes(1))],
    }));
    expect(paced).toMatchObject({ stopped: "none", stops: [], nextDueAt: minutes(1), waiting: { reason: "route_budget" } });
    // The hold that put it off is over: it waits for its turn like any work.
    const over = engineStreamState("posts", facts({
      page: { holds: routeHoldRows("posts.timeline", { holdUntil: minutes(-1).toISOString(), ladderStep: 1 }) },
      counts: [counts("posts.refresh", { nextDueAt: minutes(1) })],
      rows: [putOffRow("posts.refresh", minutes(1))],
    }));
    expect(over).toMatchObject({ stopped: "none", stops: [], waiting: { reason: "route_budget" } });
    // Its time has come under the hold: its next plan decides, nothing is put off now.
    const again = engineStreamState("posts", facts({
      page: { holds: routeHoldRows("posts.timeline", { holdUntil: minutes(40).toISOString() }) },
      counts: [counts("posts.refresh", { nextDueAt: minutes(-1) })],
      rows: [putOffRow("posts.refresh", minutes(-1))],
    }));
    expect(again).toMatchObject({ stopped: "none", stops: [], nextDueAt: minutes(-1) });
    // A halved route with its hold over: slower, not stopped.
    const halved = facts({ page: { holds: routeHoldRows("media.offer_stats", { effectivePerMin: 2.5, ladderStep: 1 }) } });
    expect(engineStreamState("media_stats", halved)).toMatchObject({ stopped: "none", stops: [] });
  });

  it("a key whose every route is held is stopped until the hold's end, whatever its row says", () => {
    const putOff = putOffRow("subscribers.poll", minutes(40));
    const hold = { holds: routeHoldRows("subscribers.page", { holdUntil: minutes(40).toISOString() }) };
    const held = engineStreamState("subscribers", facts({
      page: hold, counts: [counts("subscribers.poll", { nextDueAt: minutes(40) })], rows: [putOff],
    }));
    expect(held.waiting).toEqual({ resource: "subscribers.poll", reason: "route_hold", until: minutes(40) });
    expect(held.stops).toEqual([
      { reason: "route_hold", by: ["subscribers.page"], resources: ["subscribers.poll", "subscribers.history"], until: minutes(40) },
    ]);
    expect(held.stopped).toBe("some");
    // The route's pace put the row off a minute, then a 429 of another key's
    // request held the route: the key is out of the pick until the hold ends.
    const heldLater = engineStreamState("subscribers", facts({
      page: hold, counts: [counts("subscribers.poll", { nextDueAt: minutes(1) })], rows: [putOffRow("subscribers.poll", minutes(1))],
    }));
    expect(heldLater.stops.map((stop) => stop.until)).toEqual([minutes(40)]);
    const paced = engineStreamState("subscribers", facts({
      counts: [counts("subscribers.poll", { nextDueAt: minutes(1) })], rows: [putOffRow("subscribers.poll", minutes(1))],
    }));
    expect(paced.waiting).toMatchObject({ resource: "subscribers.poll", reason: "route_budget" });
    expect(paced.stopped).toBe("none");
  });

  // The pin behind "held never reads as reading": whichever route of a key a
  // 429 holds, once the hold has put the key's page-level work off the stream
  // says so — the stop names the key, and the wait the engine gives for the
  // row is never said beside a stream nothing stops.
  it("every key that works per page: a hold of any one of its routes that put its work off stops it", () => {
    let judged = 0;
    for (const stream of fanslyLeverStreams()) {
      for (const key of fanslyKeysForStreams([stream])) {
        if (fanslyResourceSpec(key)!.subject !== "page") continue;
        for (const route of routesOf(key)) {
          const state = engineStreamState(stream, facts({
            page: { holds: routeHoldRows(route, { holdUntil: minutes(40).toISOString() }) },
            counts: [counts(key, { nextDueAt: minutes(40) })],
            rows: [putOffRow(key, minutes(40))],
          }));
          const at = `${stream}: ${key} on ${route}`;
          expect(state.waiting, at).toEqual({ resource: key, reason: "route_hold", until: minutes(40) });
          expect(state.stopped, at).not.toBe("none");
          const stop = state.stops.find((entry) => entry.reason === "route_hold" && entry.resources.includes(key));
          expect(stop, at).toMatchObject({ by: [route], until: minutes(40) });
          expect(state.nextDueAt, at).toBeNull();
          judged += 1;
        }
      }
    }
    // The keys the review named are among them: each reads more than one route.
    for (const key of ["followers.reconcile", "posts.refresh", "posts.backfill", "catalog.fixed", "catalog.hydrate",
      "fan-earnings.roster", "stats.daily", "stats.backfill", "payouts.daily"]) {
      expect(fanslyResourceSpec(key)!.subject, key).toBe("page");
      expect(routesOf(key).length, key).toBeGreaterThan(1);
    }
    expect(judged).toBeGreaterThan(50);
  });

  // The row is read for the keys that work per page. A key that works per
  // subject and reads several routes has no such row: its stream still never
  // reads as read under a hold of one of them only because each of its routes
  // is the one route of another key of the stream, which that hold stops.
  it("a key that reads several routes works per page, or shares each of them with a one-route key of its stream", () => {
    const perSubject: string[] = [];
    for (const stream of fanslyLeverStreams()) {
      const keys = fanslyKeysForStreams([stream]);
      for (const key of keys) {
        const routes = routesOf(key);
        if (routes.length < 2 || fanslyResourceSpec(key)!.subject === "page") continue;
        perSubject.push(key);
        for (const route of routes) {
          const sibling = keys.find((other) => other !== key && routesOf(other).join() === route);
          expect(sibling, `${stream}: ${key} on ${route}`).toBeDefined();
          const state = engineStreamState(stream, facts({ page: { holds: routeHoldRows(route, { holdUntil: minutes(40).toISOString() }) } }));
          expect(state.stopped, `${stream}: ${route}`).toBe("some");
        }
      }
    }
    expect(perSubject).toEqual(["dm-conversations.find"]);
  });

  it("a resource breaker stops the keys of its file and leaves the stream's other keys", () => {
    const broken = facts({
      page: { holds: [resourceBreakerRow("followers", minutes(240), { step: 2 })] },
      counts: [counts("followers.head", { nextDueAt: minutes(-2) }), counts("fan-profiles.lookup", { nextDueAt: minutes(15) })],
      rows: [row("followers.head", { dueAt: minutes(-2), waitingReason: null, waitingUntil: null })],
    });
    const followers = engineStreamState("followers", broken);
    expect(followers.stopped).toBe("some");
    expect(followers.stops).toEqual([{ reason: "resource_hold", by: ["followers"], resources: ["followers.head"], until: minutes(240) }]);
    // The next read is of a key nothing stops.
    expect(followers.nextDueAt).toEqual(minutes(15));
    expect(engineStreamState("followers_reconcile", broken).stops).toEqual([
      { reason: "resource_hold", by: ["followers"], resources: ["followers.reconcile"], until: minutes(240) },
    ]);
    expect(engineStreamState("subscribers", broken).stopped).toBe("none");
  });

  it("the owner's pause: the whole page, every key of a stream, some of them, the history requests", () => {
    const all = engineStreamState("transactions", facts({ page: { pausedAll: true } }));
    expect(all).toMatchObject({ stopped: "all", paused: true });
    expect(all.stops).toEqual([{ reason: "paused", by: ["page"], resources: all.keys, until: null }]);

    const stats = engineStreamState("stats_snapshot", facts({ page: { pausedResources: ["stats.daily", "stats.hourly", "stats.backfill"] } }));
    expect(stats).toMatchObject({ stopped: "all", paused: true });
    expect(stats.stops).toEqual([{ reason: "paused", by: ["keys"], resources: stats.keys, until: null }]);

    const some = engineStreamState("dm_conversations", facts({ page: { pausedResources: ["dm-conversations.full", "fan-profiles.probe"] } }));
    expect(some).toMatchObject({ stopped: "some", paused: false });
    expect(some.stops).toEqual([{ reason: "paused", by: ["keys"], resources: ["dm-conversations.full", "fan-profiles.probe"], until: null }]);

    const requests = engineStreamState("dm_messages", facts({ page: { pausedRequests: true } }));
    expect(requests).toMatchObject({ stopped: "some", paused: false });
    expect(requests.stops).toEqual([{ reason: "paused", by: ["requests"], resources: ["dm-messages.history"], until: null }]);
  });

  // Ending one stop leaves the others: a resume of a paused key on a held
  // page sends nothing, and the surface must be able to say so.
  it("names a key under everything that stops it, in the order the engine judges a row", () => {
    const stopped = {
      pausedResources: ["followers.head", "followers.reconcile"],
      holds: [
        pageHoldRow("auth", INDEFINITE_UNTIL),
        resourceBreakerRow("followers", minutes(240)),
        ...routeHoldRows("followers.page", { holdUntil: minutes(40).toISOString() }),
      ],
    };
    const state = engineStreamState("followers", facts({ page: stopped }));
    expect(state.stops).toEqual([
      { reason: "paused", by: ["keys"], resources: ["followers.head"], until: null },
      { reason: "page_hold", by: ["auth"], resources: ["followers.head", "fan-profiles.lookup"], until: null },
      { reason: "resource_hold", by: ["followers"], resources: ["followers.head"], until: minutes(240) },
      { reason: "route_hold", by: ["followers.page"], resources: ["followers.head"], until: minutes(40) },
    ]);
    expect(state).toMatchObject({ stopped: "all", paused: false });
    // Work the route's hold put off is named under the hold too, whatever
    // else stops its key: a resume alone would send nothing of it.
    const walk = engineStreamState("followers_reconcile", facts({ page: stopped, rows: [putOffRow("followers.reconcile", minutes(40))] }));
    expect(walk.stops.map((stop) => [stop.reason, stop.resources])).toEqual([
      ["paused", ["followers.reconcile"]],
      ["page_hold", ["followers.reconcile", "fan-profiles.lookup"]],
      ["resource_hold", ["followers.reconcile"]],
      ["route_hold", ["followers.reconcile"]],
    ]);
  });

  it("hold rows this build cannot read stop every key", () => {
    const state = engineStreamState("light", facts({
      page: { holds: [{ scope: "page", key: "", kind: "a_kind_of_tomorrow", until: null, since: NOW, ladderStep: 0, detail: {}, revision: 1 }] },
    }));
    expect(state.stops).toEqual([{ reason: "page_hold", by: ["unreadable"], resources: ["account.poll"], until: null }]);
  });

  it("engineStops answers for any set of keys, a key without a lever among them", () => {
    const held = facts({ page: { holds: [pageHoldRow("auth", INDEFINITE_UNTIL)] } });
    // A deletion mark sends nothing: no page hold stops it.
    expect(engineStops(["dm-live.deletions"], held)).toEqual({ stops: [], stopped: "none", paused: false });
    expect(engineStops(["dm-live.deletions", "ws.connect"], held)).toMatchObject({
      stopped: "some",
      stops: [{ reason: "page_hold", by: ["auth"], resources: ["ws.connect"], until: null }],
    });
    expect(engineStops([], held)).toEqual({ stops: [], stopped: "none", paused: false });
    // The page's rows count: a key whose work a route's hold put off is
    // stopped, a key whose row waits for anything else is not.
    const hold = { holds: routeHoldRows("payouts.requests", { holdUntil: minutes(40).toISOString() }) };
    const keys = ["payouts.daily", "payouts.walk", "posts.refresh"];
    // `payouts.walk` reads that route alone; the poll reads the methods too,
    // and the route's own interval put it off a minute past the hold: one
    // stop, until the hold's end — from then on the poll is queued.
    expect(engineStops(keys, facts({ page: hold, rows: [putOffRow("payouts.daily", minutes(41)), row("posts.refresh", { id: 2 })] }))).toEqual({
      stopped: "some",
      paused: false,
      stops: [{ reason: "route_hold", by: ["payouts.requests"], resources: ["payouts.daily", "payouts.walk"], until: minutes(40) }],
    });
    // Put off for less than the hold lasts: stopped until it is due again.
    expect(engineStops(keys, facts({ page: hold, rows: [putOffRow("payouts.daily", minutes(2))] })).stops).toEqual([
      { reason: "route_hold", by: ["payouts.requests"], resources: ["payouts.daily"], until: minutes(2) },
      { reason: "route_hold", by: ["payouts.requests"], resources: ["payouts.walk"], until: minutes(40) },
    ]);
  });
});

describe("a Settings block of an engine page", () => {
  it("names its own keys, its polls and the keys the owner paused; nothing of it in the metrics", () => {
    const block = buildEngineDomainBlock("audience", facts({
      page: { pausedResources: ["followers.head", "media-stats.walk"] },
      counts: [counts("subscribers.poll", { nextDueAt: minutes(30) }), counts("followers.head", { nextDueAt: minutes(-2) })],
      appliedAt: { "subscribers.poll": minutes(-30) },
    }));
    expect(block.metrics).toEqual({});
    expect(block.engine).toEqual({
      mode: "live",
      ownerRunning: true,
      keys: ["subscribers.poll", "subscribers.history", "followers.head", "followers.reconcile", "fan-profiles.lookup"],
      pollKeys: ["subscribers.poll", "followers.head"],
      pausedKeys: ["followers.head"],
      pausedAll: false,
      stopped: "some",
      stops: [{ reason: "paused", by: ["keys"], resources: ["followers.head"], until: null }],
      paused: false,
      activeWork: 2,
      quarantined: { count: 0, resources: [] },
      blockedByVendor: { count: 0, resources: [] },
    });
    // Its next read is of a key nothing stops, and each stream says what stops it.
    expect(block.nextDueAt).toBe(minutes(30).toISOString());
    expect(block.substreams.map((substream) => [substream.stream, substream.engine])).toEqual([
      ["subscribers", { stopped: "none", stops: [], paused: false, activeWork: 1 }],
      ["followers", {
        stopped: "some", stops: [{ reason: "paused", by: ["keys"], resources: ["followers.head"], until: null }], paused: false, activeWork: 1,
      }],
      ["followers_reconcile", { stopped: "none", stops: [], paused: false, activeWork: 0 }],
    ]);
  });

  // The block's line names every key the hold stops: the list poll by its
  // one route, the reconcile walk by its work the hold put off.
  it("names the keys whose work a route's hold put off beside those all of whose routes it holds", () => {
    const block = buildEngineDomainBlock("audience", facts({
      page: { holds: routeHoldRows("followers.page", { holdUntil: minutes(40).toISOString() }) },
      counts: [
        counts("subscribers.poll", { nextDueAt: minutes(30) }),
        counts("followers.head", { nextDueAt: minutes(-2) }),
        counts("followers.reconcile", { nextDueAt: minutes(40) }),
      ],
      rows: [putOffRow("followers.reconcile", minutes(40))],
    }));
    const hold = { reason: "route_hold", by: ["followers.page"], until: minutes(40).toISOString() };
    expect(block.engine).toMatchObject({
      stopped: "some",
      paused: false,
      stops: [{ ...hold, resources: ["followers.head", "followers.reconcile"] }],
    });
    expect(block.substreams.map((substream) => [substream.stream, substream.engine?.stopped, substream.engine?.stops])).toEqual([
      ["subscribers", "none", []],
      ["followers", "some", [{ ...hold, resources: ["followers.head"] }]],
      ["followers_reconcile", "some", [{ ...hold, resources: ["followers.reconcile"] }]],
    ]);
    // The block's next read is of the key nothing stops.
    expect(block.nextDueAt).toBe(minutes(30).toISOString());
    expect(block.substreams[2]).toMatchObject({ nextDueAt: null, statusReason: { code: "route_hold" } });
  });

  it("says a 429's hold of its route and has no next read while it stands", () => {
    const block = buildEngineDomainBlock("messages_history", facts({
      page: { holds: routeHoldRows("messages.page", { holdUntil: minutes(40).toISOString() }) },
      counts: [counts("dm-messages.head", { active: 2, nextDueAt: minutes(-1) })],
      appliedAt: { "dm-messages.head": minutes(-8) },
    }));
    expect(block.engine).toMatchObject({
      keys: ["dm-messages.head", "dm-messages.catchup", "dm-messages.history"],
      // No poll: a "sync now" of the block has nothing to move.
      pollKeys: [],
      stopped: "all",
      paused: false,
      stops: [{
        reason: "route_hold", by: ["messages.page"], resources: ["dm-messages.head", "dm-messages.catchup", "dm-messages.history"],
        until: minutes(40).toISOString(),
      }],
    });
    expect(block.nextDueAt).toBeNull();
    expect(block.succeededAt).toBe(minutes(-8).toISOString());
  });

  it("counts the quarantined and the refused work of its own keys, by key", () => {
    const block = buildEngineDomainBlock("financials", facts({
      counts: [
        counts("transactions.rescan", { quarantined: 1 }),
        counts("transactions.head", { active: 3, quarantined: 2, blockedByVendor: 1 }),
        counts("top-spenders.window", { blockedByVendor: 1 }),
        // Another block's quarantine is not this block's to requeue.
        counts("dm-conversations.head", { quarantined: 1 }),
      ],
    }));
    expect(block.needsAttention).toBe(true);
    expect(block.engine).toMatchObject({
      quarantined: { count: 3, resources: ["transactions.head", "transactions.rescan"] },
      blockedByVendor: { count: 2, resources: ["transactions.head", "top-spenders.window"] },
      activeWork: 5,
    });
  });

  it("a credentials hold stops every block and asks for credentials on the connection block alone", () => {
    const held = facts({ page: { holds: [pageHoldRow("auth", INDEFINITE_UNTIL)] } });
    for (const key of SYNC_DOMAIN_BLOCKS) {
      const block = buildEngineDomainBlock(key, held);
      expect(block.engine, key).toMatchObject({
        stopped: "all",
        stops: [{ reason: "page_hold", by: ["auth"], until: null }],
        quarantined: { count: 0, resources: [] },
      });
      expect(block.needsAttention, key).toBe(key === "connection");
    }
    expect(buildEngineDomainBlock("connection", held).statusReason?.code).toBe("credentials_invalid");
  });

  it("says when no host runs the page, and when the owner paused it whole", () => {
    const orphan = buildEngineDomainBlock("financials", facts({
      page: { owner: { generation: 3n, host: "sync-1", acquiredAt: minutes(-60), heartbeatAt: minutes(-5), releasedAt: null, releaseGeneration: null } },
    }));
    expect(orphan.engine).toMatchObject({ ownerRunning: false, stopped: "none" });
    const paused = buildEngineDomainBlock("financials", facts({ page: { pausedAll: true } }));
    expect(paused.engine).toMatchObject({ pausedAll: true, pausedKeys: [], stopped: "all", paused: true });
  });
});

describe("whether a host runs the page", () => {
  it("takes a fresh heartbeat of an owner in a mode an actor runs in", () => {
    expect(engineOwnerRunning(facts())).toBe(true);
    // The owner stopped beating.
    expect(engineOwnerRunning(facts({
      page: { owner: { generation: 3n, host: "sync-1", acquiredAt: minutes(-60), heartbeatAt: minutes(-5), releasedAt: null, releaseGeneration: null } },
    }))).toBe(false);
    // Nobody ever owned it.
    expect(engineOwnerRunning(facts({
      page: { owner: { generation: 0n, host: null, acquiredAt: null, heartbeatAt: null, releasedAt: null, releaseGeneration: null } },
    }))).toBe(false);
    // A handover: neither engine sends.
    expect(engineOwnerRunning(facts({ page: { mode: "handover" } }))).toBe(false);
  });

  it("without one every row waits for an owner, whatever else is true of it", () => {
    const state = engineStreamState("light", facts({
      page: { owner: { generation: 0n, host: null, acquiredAt: null, heartbeatAt: null, releasedAt: null, releaseGeneration: null } },
      counts: [counts("account.poll", { nextDueAt: minutes(-10) })],
      rows: [row("account.poll", { dueAt: minutes(-10), waitingReason: null, waitingUntil: null })],
    }));
    expect(state.waiting).toEqual({ resource: "account.poll", reason: "ownership_unconfirmed", until: null });
  });
});
