import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSyncPage, paceFloorFromDb, readFanslySendAudit, upsertDemand, type Database } from "@agency_hub_core/db";
import type { FanslyWireId } from "@agency_hub_core/fansly";

import { TAKEOVER_FACTOR } from "../apps/runtime/src/sync/engine/pacer.ts";
import { createEngineRegistry, type EngineRegistry, type EngineResourceSpec, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { auditPagePace, auditRouteIntervals } from "../apps/runtime/src/sync/engine/send-audit.ts";
import { FAMILY_BUDGETS, intervalMsOf, routeBudget, type FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";
import { explainSyncWork, readSyncPageStatus } from "../apps/runtime/src/sync/inspect.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  makeTestActor,
  okResponse,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  testConfig,
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

/** Reads `spec` once, then is done. */
function once(spec: FanslyWireId): ResourceModule {
  return {
    async plan() {
      return { kind: "request", request: { spec, params: requestParams(spec) as never } };
    },
    async apply() {
      return { work: { satisfiesRevision: true, close: "done", closeReason: "read" }, followups: [] };
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
  options: { scale: number; settingMs?: number; metrics?: RecordingMetrics; transport?: ScriptedLiveTransport },
  done: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  // Each run takes the page over as the host does (I5, `engine/host.ts`): its
  // first send waits the floor the database computes from every earlier one.
  const settingMs = options.settingMs ?? TEST_PAUSE_MS;
  const floorDelayMs = await paceFloorFromDb(db(), { pageId, settingMs });
  const { actor, stop, abort } = await makeTestActor({
    db: db(), pageId, registry: reg, routeTimeScale: options.scale, settingMs, floorDelayMs,
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    transport: options.transport ?? routeTransport(),
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

describe("the legacy engine's sends before the switch (takeover)", () => {
  const SCALE = 0.25;
  const FAMILY_MS = scaled(FAMILY_BUDGETS.messaging.currentPerMin, SCALE);

  async function legacySend(pageId: number, operation: string): Promise<Date> {
    const result = await testDb!.pool.query<{ sent_at: Date }>(
      `insert into fansly_send_log (page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance,
              captured_at, sent_at, completed_at, outcome)
       values ($1, gen_random_uuid(), 'sync_stream', $2, 'worker', 1, 'worker', gen_random_uuid(),
               clock_timestamp(), clock_timestamp(), clock_timestamp(), 'response')
       returning sent_at`,
      [pageId, operation],
    );
    return result.rows[0]!.sent_at;
  }

  it("count through the operation map: the engine's first /message waits the family's interval after the legacy list read", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLive();
    const reg = createEngineRegistry([testSpec("msg.once", once("messages.page"), { operations: ["messages.page"] })]);
    const legacyAt = await legacySend(pageId, "messaging_groups");
    await demand(pageId, reg, "msg.once");
    await runUntil(pageId, reg, { scale: SCALE }, async () => (await sends(pageId)).length >= 1);
    const [first] = await sends(pageId);
    expect(first!.sent_at.getTime() - legacyAt.getTime()).toBeGreaterThanOrEqual(FAMILY_MS);
  }, 60_000);
});

describe("the final check of the planned route", () => {
  it("puts off a probe whose planned route is closed — nothing admitted, due when the route opens — then sends it", async (context) => {
    if (!testDb) return context.skip();
    const SCALE = 0.25;
    const pageId = await seedLive();
    // The probe declares no route (its route is the owner's): only its plan
    // names one, and that route was just read by another key.
    const reg = createEngineRegistry([
      testSpec("media.once", once("media.offer_stats"), { operations: ["media.offer_stats"] }),
      testSpec("probe.test", once("media.offer_stats"), { class: "planned", operations: [] }),
    ]);
    await demand(pageId, reg, "media.once");
    const metrics = new RecordingMetrics();
    await runUntil(pageId, reg, { scale: SCALE, metrics }, async () => (await sends(pageId)).length >= 1);
    await demand(pageId, reg, "probe.test");
    await runUntil(pageId, reg, { scale: SCALE, metrics }, async () => {
      const row = await testDb!.pool.query<{ waiting_reason: string | null }>(
        "select waiting_reason from sync_work where page_id = $1 and resource = 'probe.test'", [pageId]);
      return row.rows[0]?.waiting_reason === "pacer";
    });
    expect(metrics.get("sync_route_deferred")).toBe(1);
    const deferred = await testDb.pool.query<{ due_at: Date; state: string; attempts: number }>(
      `select w.due_at, w.state, (select count(*)::int from sync_attempts a where a.work_id = w.id) as attempts
         from sync_work w where w.page_id = $1 and w.resource = 'probe.test'`, [pageId]);
    const [mediaRead] = await sends(pageId);
    const mediaMs = scaled(routeBudget("media.offer_stats").currentPerMin, SCALE);
    expect(deferred.rows[0]).toMatchObject({ state: "open", attempts: 0 });
    expect(Math.abs(deferred.rows[0]!.due_at.getTime() - (mediaRead!.sent_at.getTime() + mediaMs))).toBeLessThan(50);
    // Due again when the route opens: then it goes out, a route interval after.
    await runUntil(pageId, reg, { scale: SCALE, metrics }, async () => (await sends(pageId)).length >= 2);
    const [first, probe] = await sends(pageId);
    expect(probe!.resource).toBe("probe.test");
    expect(probe!.sent_at.getTime() - first!.sent_at.getTime()).toBeGreaterThanOrEqual(mediaMs);
  }, 60_000);
});

describe("the short look-ahead", () => {
  it("holds the slot for the class whose turn it is when its route opens within 1.2 × S: urgent keeps its five slots a lap", async (context) => {
    if (!testDb) return context.skip();
    // S = 100 ms; the family's 4 s at 0.045 is 180 ms — a page pause and a
    // bit, inside the look-ahead. Without it, the planned reads would take
    // every slot urgent's route is closed for.
    const SCALE = 0.045;
    const pageId = await seedLive();
    const reg = createEngineRegistry([
      busySpec("msg.read", "messages.page"),
      busySpec("polls.read", "polls", { class: "planned" }),
    ]);
    await demand(pageId, reg, "msg.read");
    await demand(pageId, reg, "polls.read");
    const metrics = new RecordingMetrics();
    await runUntil(pageId, reg, { scale: SCALE, settingMs: 100, metrics }, async () => (await sends(pageId)).length >= 36, 60_000);
    const all = await sends(pageId);
    const urgent = all.filter((attempt) => attempt.resource === "msg.read").length;
    const planned = all.filter((attempt) => attempt.resource === "polls.read").length;
    expect(metrics.get("sync_route_lookahead_waits")).toBeGreaterThan(0);
    expect(urgent).toBeGreaterThanOrEqual(3 * planned);
    expect(planned).toBeGreaterThanOrEqual(4);
    expectBudget(all, ["messages.page"], scaled(FAMILY_BUDGETS.messaging.currentPerMin, SCALE));
  }, 90_000);
});

describe("the route state namespace", () => {
  async function writeRouteState(pageId: number, value: unknown): Promise<void> {
    await testDb!.pool.query(
      "update sync_pages set resource_holds = jsonb_set(resource_holds, '{route:state}', $2::jsonb) where page_id = $1",
      [pageId, JSON.stringify(value)],
    );
  }

  it("is apart from the resource holds on the page row", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLive();
    await testDb.pool.query(
      `update sync_pages set resource_holds = '{"posts": {"until": "2099-01-01T00:00:00Z", "step": 1, "since": "2026-10-03T00:00:00Z"}}'::jsonb
        where page_id = $1`, [pageId]);
    await writeRouteState(pageId, { version: 1, routes: {} });
    const page = await getSyncPage(db(), pageId);
    expect(Object.keys(page!.resourceHolds)).toEqual(["posts"]);
    expect(page!.routeState).toEqual({ version: 1, routes: {} });
  }, 60_000);

  it("a version this build cannot read admits nothing; a readable state's route hold closes that route only", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLive();
    const reg = createEngineRegistry([busySpec("msg.read", "messages.page"), busySpec("polls.read", "polls", { class: "planned" })]);
    await demand(pageId, reg, "msg.read");
    await demand(pageId, reg, "polls.read");
    await writeRouteState(pageId, { version: 9, routes: {} });
    const metrics = new RecordingMetrics();
    await runUntil(pageId, reg, { scale: 0, metrics }, async () => metrics.get("sync_route_state_unreadable") >= 2, 30_000);
    expect(await sends(pageId)).toEqual([]);

    const holdUntil = new Date(Date.now() + 1_500);
    await writeRouteState(pageId, {
      version: 1,
      routes: { polls: { holdUntil: holdUntil.toISOString(), ladderStep: 1, effectivePerMin: null, policyVersion: null, last429AttemptId: null, last429At: null, revision: 1 } },
    });
    await runUntil(pageId, reg, { scale: 0 }, async () => (await sends(pageId)).some((attempt) => attempt.operation === "polls"));
    const all = await sends(pageId);
    const firstPolls = all.find((attempt) => attempt.operation === "polls")!;
    expect(firstPolls.sent_at.getTime()).toBeGreaterThanOrEqual(holdUntil.getTime());
    // `/message` went out meanwhile, at the page pace.
    expect(all.filter((attempt) => attempt.operation === "messages.page" && attempt.sent_at < holdUntil).length).toBeGreaterThan(5);
  }, 60_000);
});

describe("the owner's status and why", () => {
  it("show each route's budget, its newest send and when it opens; a closed key waits on `pacer` naming its routes", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLive();
    const reg = createEngineRegistry([testSpec("media-stats.walk", once("media.offer_stats"), { class: "planned", kind: "goal", operations: ["media.offer_stats"] })]);
    await demand(pageId, reg, "media-stats.walk");
    // One media read at the production budget: the route stays closed for 12 s.
    await runUntil(pageId, reg, { scale: 1 }, async () => (await sends(pageId)).length >= 1);
    await demand(pageId, reg, "media-stats.walk");
    const config = testConfig(testDb.connectionString);
    const page = (await getSyncPage(db(), pageId))!;
    const status = await readSyncPageStatus(db(), config, page);
    const media = status.routes!.routes.find((route) => route.name === "media.offer_stats")!;
    expect(media).toMatchObject({ family: null, ceilingPerMin: 12, currentPerMin: 5, effectivePerMin: 5, intervalMs: 12_000, holdUntil: null });
    expect(media.lastSendAt).not.toBeNull();
    expect(Date.parse(media.opensAt!) - Date.parse(media.lastSendAt!)).toBe(12_000);
    expect(status.routes!.stateError).toBeNull();
    const [why] = await explainSyncWork(db(), config, page, { resource: "media-stats.walk" });
    expect(why!.waiting).toMatchObject({ reason: "pacer", detail: { routeBudget: true, routes: ["media.offer_stats"] } });
    expect(why!.waiting!.until!.toISOString()).toBe(media.opensAt);
  }, 60_000);
});
