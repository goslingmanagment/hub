import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  paceFloorFromDb,
  readFanslySendAudit,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireId } from "@agency_hub_core/fansly";

import { TAKEOVER_FACTOR } from "../apps/runtime/src/sync/engine/pacer.ts";
import { createEngineRegistry, type EngineRegistry, type EngineResourceSpec, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { auditPagePace, auditRouteIntervals } from "../apps/runtime/src/sync/engine/send-audit.ts";
import { FAMILY_BUDGETS, intervalMsOf, routeBudget, type FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  makeTestActor,
  okResponse,
  ScriptedLiveTransport,
  seedSyncPage,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The strict route admission through the real actor, commits and a real
// database (step 3b rulings 1, 3, 4; plan PR 1-1), the route budgets scaled
// down with the test pause: every route and family keeps its budget on the
// journal while the page's other routes go on; a restarted actor reads its
// clocks back from the journal; the legacy engine's sends before the switch
// count; the planned request's own
// route is checked last (a probe whose route is closed is put off, nothing
// admitted); the short look-ahead holds a slot for the class whose turn it
// is; a route state this build cannot read closes the page's admission and a
// stored route hold closes its route only; the owner's status and "why"
// name the budgets.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

/** Keeps reading `spec` as fast as the actor admits it. */
function busy(spec: FanslyWireId): ResourceModule {
  return {
    async plan() {
      return { kind: "request", request: { spec, params: requestParams(spec) as never } };
    },
    async apply(_tx, input) {
      return { work: { satisfiesRevision: false, nextDueAt: input.now }, followups: [] };
    },
  };
}

function requestParams(spec: FanslyWireId): unknown {
  switch (spec) {
    case "messages.page":
      return { groupId: "70000000000000001", before: null, after: null };
    case "messaging.groups":
      return { offset: 0 };
    case "media.offer_stats":
      return { mediaOfferId: "777", beforeMs: 2_000_000_000_000, afterMs: 1_990_000_000_000, periodMs: 86_400_000 };
    default:
      return {};
  }
}

/** A live transport whose answers pass each route's contract. */
function routeTransport(): ScriptedLiveTransport {
  const transport = new ScriptedLiveTransport();
  transport.respond = (req) => {
    switch (req.spec) {
      case "messages.page":
        return okResponse({ messages: [] });
      case "messaging.groups":
        return okResponse({ data: [] });
      default:
        return okResponse();
    }
  };
  return transport;
}

function busySpec(key: string, spec: FanslyWireId, overrides: Partial<EngineResourceSpec> = {}): EngineResourceSpec {
  return testSpec(key, busy(spec), { kind: "goal", operations: [spec], ...overrides });
}

async function demand(pageId: number, reg: EngineRegistry, resource: string): Promise<void> {
  const spec = reg.spec(resource)!;
  await upsertDemand(db(), { pageId, resource, subject: "", kind: spec.kind, class: spec.class, demand: { reasons: ["test"] } });
}

/** The test pause S (the harness default). */
const TEST_PAUSE_MS = 30;

interface Attempt {
  id: number;
  resource: string;
  operation: FanslyRoute;
  sent_at: Date;
  class: string;
  generation: string;
  setting_ms: number;
  pause_ms: number;
  gap_prev_ms: number | null;
}

async function sends(pageId: number): Promise<Attempt[]> {
  const result = await testDb!.pool.query<Attempt>(
    `select id::int as id, resource, operation, sent_at, class, owner_generation::text as generation,
            setting_ms, pause_ms, gap_prev_ms
       from sync_attempts
      where page_id = $1 and not shadow and sent_at is not null order by sent_at, id`,
    [pageId],
  );
  return result.rows;
}

function scaled(perMin: number, scale: number): number {
  return Math.ceil(intervalMsOf(perMin) * scale);
}

/** Consecutive sends of `routes` are at least `intervalMs` apart. */
function expectBudget(all: readonly Attempt[], routes: readonly FanslyRoute[], intervalMs: number): number {
  const times = all.filter((attempt) => routes.includes(attempt.operation)).map((attempt) => attempt.sent_at.getTime());
  for (let i = 1; i < times.length; i += 1) {
    expect(times[i]! - times[i - 1]!, `${routes.join("+")} gap ${i}`).toBeGreaterThanOrEqual(intervalMs);
  }
  return times.length;
}

/**
 * The page's pace on its journal, as the engine guarantees it: within one
 * owner generation (I1) each send is at least its own S × (1 + u)
 * (`pause_ms`) after the previous one, on the monotonic clock the pacer keeps
 * it on (`gap_prev_ms`, measured at the actual send); across a takeover (I5)
 * the new owner's first send is at least 1.2 × S after the previous owner's
 * last recorded send. Returns the number of takeovers.
 */
function expectPagePace(all: readonly Attempt[]): number {
  let takeovers = 0;
  for (let i = 1; i < all.length; i += 1) {
    const previous = all[i - 1]!;
    const next = all[i]!;
    if (next.generation === previous.generation) {
      expect(next.gap_prev_ms, `page gap ${i}: the pacer's own gap`).not.toBeNull();
      expect(next.gap_prev_ms!, `page gap ${i}`).toBeGreaterThanOrEqual(next.pause_ms);
    } else {
      takeovers += 1;
      expect(next.sent_at.getTime() - previous.sent_at.getTime(), `page gap ${i} (takeover)`)
        .toBeGreaterThanOrEqual(next.setting_ms * TAKEOVER_FACTOR);
    }
  }
  return takeovers;
}

async function runUntil(
  pageId: number,
  reg: EngineRegistry,
  options: { scale: number },
  done: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  // Each run takes the page over as the host does (I5, `engine/host.ts`): its
  // first send waits the floor the database computes from every earlier one.
  const settingMs = TEST_PAUSE_MS;
  const floorDelayMs = await paceFloorFromDb(db(), { pageId, settingMs });
  const { actor, stop, abort } = await makeTestActor({
    db: db(), pageId, registry: reg, routeTimeScale: options.scale, settingMs, floorDelayMs,
    transport: routeTransport(),
  });
  const running = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await done()) ? true : null), timeoutMs, "the run");
  } finally {
    stop.abort();
    await running;
  }
}

async function seedLive(): Promise<number> {
  return (await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" })).pageId;
}

describe("route budgets on the journal", () => {
  const SCALE = 0.05;
  // Four endless planned walks (round robin by key): `/message` and the list
  // share the messaging family.
  const registry = () => createEngineRegistry([
    busySpec("msg.read", "messages.page", { class: "planned" }),
    busySpec("list.read", "messaging.groups", { class: "planned" }),
    busySpec("polls.read", "polls", { class: "planned" }),
    busySpec("media.read", "media.offer_stats", { class: "planned" }),
  ]);

  it("every route and the messaging family keep their budgets, the other routes going on between; a restart reads the clocks back", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLive();
    const reg = registry();
    for (const key of ["msg.read", "list.read", "polls.read", "media.read"]) await demand(pageId, reg, key);
    const enough = (n: number) => async () => (await sends(pageId)).length >= n;
    await runUntil(pageId, reg, { scale: SCALE }, enough(20));
    // The actor restarts — a new owner generation: its route clocks come
    // from the journal, its first send waits the takeover floor.
    await runUntil(pageId, reg, { scale: SCALE }, enough(40));

    const all = await sends(pageId);
    const media = expectBudget(all, ["media.offer_stats"], scaled(routeBudget("media.offer_stats").currentPerMin, SCALE));
    const list = expectBudget(all, ["messaging.groups"], scaled(routeBudget("messaging.groups").currentPerMin, SCALE));
    const polls = expectBudget(all, ["polls"], scaled(routeBudget("polls").currentPerMin, SCALE));
    const family = expectBudget(all, ["messages.page", "messaging.groups", "group.detail"], scaled(FAMILY_BUDGETS.messaging.currentPerMin, SCALE));
    // Every walk had its turns (≈ 6 / 8 / 17 / 17 here): no route starves another.
    expect(media).toBeGreaterThanOrEqual(3);
    expect(list).toBeGreaterThanOrEqual(4);
    expect(polls).toBeGreaterThanOrEqual(8);
    expect(family - list).toBeGreaterThanOrEqual(4);
    // Never two sends of the page closer than the pacer's S × (1 + u), nor
    // the restart's first send closer than 1.2 × S to the last one before it.
    expect(expectPagePace(all)).toBe(1);

    // Each admission recorded the intervals its route check applied, and the
    // send audit over the journal finds every pair within them (I1, I19).
    const route = (wire: FanslyRoute) => scaled(routeBudget(wire).currentPerMin, SCALE);
    const messaging = scaled(FAMILY_BUDGETS.messaging.currentPerMin, SCALE);
    expect((await testDb.pool.query(
      `select distinct operation, route_interval_ms as "route", family_interval_ms as "family"
         from sync_attempts where page_id = $1 and not shadow order by operation`,
      [pageId],
    )).rows).toEqual([
      { operation: "media.offer_stats", route: route("media.offer_stats"), family: null },
      { operation: "messages.page", route: route("messages.page"), family: messaging },
      { operation: "messaging.groups", route: route("messaging.groups"), family: messaging },
      { operation: "polls", route: route("polls"), family: null },
    ]);
    const window = { start: all[0]!.sent_at, until: null };
    const journal = await readFanslySendAudit(db(), { pageId, since: window.start });
    expect(auditPagePace(journal, window)).toMatchObject({ verdict: "pass", violations: [], inconclusive: [] });
    // (The scaled test budgets sit below the ceiling's interval: that bound is production's.)
    const intervals = auditRouteIntervals(journal, window);
    expect(intervals).toMatchObject({ violations: [], inconclusive: [], unplaced: [] });
    expect(intervals.pairs).toBeGreaterThan(30);
  }, 90_000);
});
