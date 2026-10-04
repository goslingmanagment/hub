import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSyncPage, upsertDemand, writeSyncRouteState, type Database, type SyncRouteStateEntryWrite } from "@agency_hub_core/db";
import type { FanslyWireId, FanslyWireOutcome } from "@agency_hub_core/fansly";

import { buildSyncEngineCommandGroup } from "../apps/runtime/src/sync/cli.ts";
import { createEngineRegistry, type EngineRegistry, type EngineResourceSpec, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { intervalMsOf, routePolicyVersion, type FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";
import { explainSyncWork, readSyncPageStatus } from "../apps/runtime/src/sync/inspect.ts";
import { toSyncWorkWire } from "../apps/runtime/src/sync/requests/wire.ts";
import { SYNC_ROUTE_RAISE_AUDIT_EVENT } from "../apps/runtime/src/sync/route-raise.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  testConfig,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";
import { pageHoldKindOf, routeEntryOf } from "./helpers/sync-holds.ts";

// Route holds through the real actor, commits and a real database (step 3b
// ruling 2 as amended by A2; owner decisions №22, D3, D5; plan PR 1-2): a 429
// holds ONLY the route that answered it — the page, a resource file and the
// route's family are never held, the page's other routes keep going — for
// the ladder's step (here 5 s × 1.1, the test actor's jitter draw is 0.5) or
// a Retry-After to the letter; it halves the page+route's rate durably (a
// restarted actor keeps it, the next 429 takes the next step); a 5xx naming
// its Retry-After holds its route without a slowdown; the capture opens the
// route's own incident; "why" and the status name the hold; the owner's
// `sync route raise` is one audited step of ≤ +1/min against the revision
// its evidence read.

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

function requestParams(spec: FanslyWireId): unknown {
  switch (spec) {
    case "messages.page":
      return { groupId: "70000000000000001", before: null, after: null };
    case "messaging.groups":
      return { offset: 0 };
    case "transactions.page":
      return { limit: 20, offset: 0 };
    default:
      return {};
  }
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
    async shadow(_work, _request, ctx) {
      return { work: { satisfiesRevision: false, nextDueAt: ctx.now }, followups: [] };
    },
  };
}

function busySpec(key: string, spec: FanslyWireId, overrides: Partial<EngineResourceSpec> = {}): EngineResourceSpec {
  return testSpec(key, busy(spec), { kind: "goal", class: "planned", operations: [spec], ...overrides });
}

function answerOf(spec: string): FanslyWireOutcome {
  switch (spec) {
    case "messages.page":
      return okResponse({ messages: [] });
    case "messaging.groups":
      return okResponse({ data: [] });
    case "transactions.page":
      return okResponse({ total: 0, data: [] });
    default:
      return okResponse();
  }
}

function refused(status: number, retryAfter: string | null): FanslyWireOutcome {
  const bodyText = JSON.stringify({ success: false, error: { code: status } });
  return {
    kind: "response",
    status,
    headers: retryAfter === null ? {} : { "retry-after": retryAfter },
    bodyText,
    bodyBytes: bodyText.length,
    sendMark: "request_start",
  };
}

async function demand(pageId: number, reg: EngineRegistry, resource: string): Promise<void> {
  const spec = reg.spec(resource)!;
  await upsertDemand(db(), { pageId, shadow: false, resource, subject: "", kind: spec.kind, class: spec.class, demand: { reasons: ["test"] } });
}

interface Attempt {
  id: number;
  operation: FanslyRoute;
  sent_at: Date;
  completed_at: Date | null;
  http_status: number | null;
  error_class: string | null;
  retry_after_ms: number | null;
}

async function sends(pageId: number): Promise<Attempt[]> {
  const result = await testDb!.pool.query<Attempt>(
    `select id::int as id, operation, sent_at, completed_at, http_status, error_class, retry_after_ms from sync_attempts
      where page_id = $1 and not shadow and sent_at is not null order by sent_at, id`,
    [pageId],
  );
  return result.rows;
}

interface StoredEntry {
  holdUntil: string | null;
  ladderStep: number;
  effectivePerMin: number | null;
  policyVersion: string | null;
  last429AttemptId: number | null;
  last429At: string | null;
  revision: number;
}

/** The route's entry as the engine reads it from the page's hold set. */
async function entryOf(pageId: number, route: FanslyRoute): Promise<StoredEntry | null> {
  return routeEntryOf((await getSyncPage(db(), pageId))!, route);
}

async function runUntil(
  pageId: number,
  reg: EngineRegistry,
  transport: ScriptedLiveTransport,
  options: { scale: number; alerts?: RecordingAlerts; metrics?: RecordingMetrics },
  done: () => Promise<boolean>,
  timeoutMs = 40_000,
): Promise<void> {
  const { actor, stop, abort } = await makeTestActor({
    db: db(), pageId, mode: "live", registry: reg, routeTimeScale: options.scale, transport,
    ...(options.alerts === undefined ? {} : { alerts: options.alerts }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
  });
  const running = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await done()) ? true : null), timeoutMs, "the run");
  } finally {
    stop.abort();
    await running;
  }
}

async function seedLive(label?: string): Promise<number> {
  return (await seedSyncPage({ db: db(), pool: testDb!.pool }, {
    mode: "live", guard: "fansly_sync_engine", ...(label === undefined ? {} : { label }),
  })).pageId;
}

function scaled(perMin: number, scale: number): number {
  return Math.ceil(intervalMsOf(perMin) * scale);
}

function entryWrite(overrides: Partial<SyncRouteStateEntryWrite> = {}): SyncRouteStateEntryWrite {
  return {
    holdUntil: null,
    ladderStep: 1,
    effectivePerMin: 7.5,
    policyVersion: routePolicyVersion("messages.page"),
    last429AttemptId: null,
    last429At: new Date(),
    ...overrides,
  };
}

describe("a route's 429 through the actor", () => {
  const SCALE = 0.05;
  const registry = () => createEngineRegistry([
    busySpec("msg.read", "messages.page"),
    busySpec("list.read", "messaging.groups"),
    busySpec("polls.read", "polls"),
  ]);

  it("holds only that route — never the page, a file or its family — for the ladder's step, then runs it at half rate, durably across a restart", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLive();
    const reg = registry();
    for (const key of ["msg.read", "list.read", "polls.read"]) await demand(pageId, reg, key);
    let lists = 0;
    const transport = new ScriptedLiveTransport();
    transport.respond = (req) => {
      if (req.spec === "messaging.groups") {
        lists += 1;
        // The first read meets the ladder; the first after the restart a Retry-After.
        if (lists === 1) return refused(429, null);
        if (lists === 5) return refused(429, "1");
      }
      return answerOf(req.spec);
    };
    const alerts = new RecordingAlerts();
    const metrics = new RecordingMetrics();
    const listSends = async () => (await sends(pageId)).filter((attempt) => attempt.operation === "messaging.groups");
    await runUntil(pageId, reg, transport, { scale: SCALE, alerts, metrics }, async () => (await listSends()).length >= 4);

    const [refusal, ...after] = await listSends();
    expect(refusal).toMatchObject({ http_status: 429, error_class: "rate_limit", retry_after_ms: null });
    const entry = (await entryOf(pageId, "messaging.groups"))!;
    expect(entry).toMatchObject({
      ladderStep: 1, effectivePerMin: 6, policyVersion: routePolicyVersion("messaging.groups"), last429AttemptId: refusal!.id, revision: 1,
    });
    // The ladder's first step, stretched by the actor's jitter draw (0.5 → 10 %).
    const holdUntil = new Date(entry.holdUntil!).getTime();
    expect(holdUntil - refusal!.completed_at!.getTime()).toBeGreaterThanOrEqual(5_500 - 50);
    expect(holdUntil - refusal!.completed_at!.getTime()).toBeLessThan(5_500 + 1_000);
    // Nothing on the route before the hold ended; then the halved rate (6/min, here 500 ms).
    expect(after[0]!.sent_at.getTime()).toBeGreaterThanOrEqual(holdUntil);
    for (let i = 1; i < after.length; i += 1) {
      expect(after[i]!.sent_at.getTime() - after[i - 1]!.sent_at.getTime(), `list gap ${i}`).toBeGreaterThanOrEqual(scaled(6, SCALE));
    }
    // The page's other routes — the list's family member `/message` included — went on meanwhile.
    const during = (await sends(pageId)).filter((attempt) => attempt.sent_at.getTime() > refusal!.sent_at.getTime() && attempt.sent_at.getTime() < holdUntil);
    expect(during.filter((attempt) => attempt.operation === "messages.page").length).toBeGreaterThan(3);
    expect(during.filter((attempt) => attempt.operation === "polls").length).toBeGreaterThan(3);
    // Never the page, never a file.
    const page = (await getSyncPage(db(), pageId))!;
    expect(page.holds.map((row) => [row.scope, row.key, row.kind])).toEqual([
      ["route", "messaging.groups", "route_budget"],
      ["route", "messaging.groups", "route_hold"],
    ]);
    // The route's own incident (D5); alert 1 never.
    expect(alerts.opened.filter((alert) => alert.subKey === "route_limited").map((alert) => [alert.route, alert.detail]))
      .toEqual([["messaging.groups", "rate_limit"]]);
    expect(alerts.opened.filter((alert) => alert.subKey === "page_stopped")).toEqual([]);
    expect(metrics.get("sync_route_held")).toBe(1);

    // A restarted actor keeps the halving; the next 429 (a Retry-After of 1 s)
    // takes the next step and halves again.
    await runUntil(pageId, reg, transport, { scale: SCALE, alerts }, async () => (await listSends()).length >= 7);
    const all = await listSends();
    const second = all[4]!;
    expect(second).toMatchObject({ http_status: 429, retry_after_ms: 1_000 });
    const next = (await entryOf(pageId, "messaging.groups"))!;
    expect(next).toMatchObject({ ladderStep: 2, effectivePerMin: 3, last429AttemptId: second.id, revision: 2 });
    expect(new Date(next.holdUntil!).getTime() - second.completed_at!.getTime()).toBeGreaterThanOrEqual(1_000 - 50);
    expect(new Date(next.holdUntil!).getTime() - second.completed_at!.getTime()).toBeLessThan(2_000);
    // Before the second 429: the restarted actor at 6/min; after it, 3/min.
    expect(all[4]!.sent_at.getTime() - all[3]!.sent_at.getTime()).toBeGreaterThanOrEqual(scaled(6, SCALE));
    expect(all[5]!.sent_at.getTime()).toBeGreaterThanOrEqual(new Date(next.holdUntil!).getTime());
    expect(all[6]!.sent_at.getTime() - all[5]!.sent_at.getTime()).toBeGreaterThanOrEqual(scaled(3, SCALE));

    // The owner's status shows the route's hold, slowdown, step and revision.
    const status = await readSyncPageStatus(db(), testConfig(testDb.connectionString), (await getSyncPage(db(), pageId))!);
    expect(status.routes!.routes.find((route) => route.name === "messaging.groups")).toMatchObject({
      effectivePerMin: 3, currentPerMin: 12, ladderStep: 2, revision: 2, holdUntil: next.holdUntil, last429At: next.last429At,
    });
  }, 90_000);

  it("a 5xx naming its Retry-After holds its route to the letter — no slowdown, no ladder step; the page goes on", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLive();
    const reg = createEngineRegistry([busySpec("money.read", "transactions.page"), busySpec("polls.read", "polls")]);
    for (const key of ["money.read", "polls.read"]) await demand(pageId, reg, key);
    let money = 0;
    const transport = new ScriptedLiveTransport();
    transport.respond = (req) => {
      if (req.spec === "transactions.page" && (money += 1) === 1) return refused(503, "2");
      return answerOf(req.spec);
    };
    const alerts = new RecordingAlerts();
    const moneySends = async () => (await sends(pageId)).filter((attempt) => attempt.operation === "transactions.page");
    await runUntil(pageId, reg, transport, { scale: 0, alerts }, async () => (await moneySends()).length >= 2);
    const [refusal, next] = await moneySends();
    expect(refusal).toMatchObject({ http_status: 503, error_class: "rate_limit", retry_after_ms: 2_000 });
    const entry = (await entryOf(pageId, "transactions.page"))!;
    expect(entry).toMatchObject({ ladderStep: 0, effectivePerMin: null, last429AttemptId: null, last429At: null, revision: 1 });
    const holdUntil = new Date(entry.holdUntil!).getTime();
    expect(holdUntil - refusal!.completed_at!.getTime()).toBeGreaterThanOrEqual(2_000 - 50);
    expect(next!.sent_at.getTime()).toBeGreaterThanOrEqual(holdUntil);
    expect((await sends(pageId)).filter((attempt) => attempt.operation === "polls"
      && attempt.sent_at.getTime() > refusal!.sent_at.getTime() && attempt.sent_at.getTime() < holdUntil).length).toBeGreaterThan(3);
    expect(pageHoldKindOf((await getSyncPage(db(), pageId))!)).toBeNull();
    expect(alerts.opened.filter((alert) => alert.subKey === "route_limited").map((alert) => [alert.route, alert.detail]))
      .toEqual([["transactions.page", "unavailable"]]);
  }, 60_000);

  it("why: a key whose routes are all held waits on `route_hold` until the hold ends, naming the held route", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLive();
    // A running owner (its fresh heartbeat), so "why" gets past ownership.
    await testDb.pool.query(
      "update sync_pages set owner_generation = 1, owner_heartbeat_at = clock_timestamp() where page_id = $1",
      [pageId],
    );
    // "Why" reads the production registry's routes of a key.
    const reg = createEngineRegistry([fanslyResourceSpec("dm-conversations.head")!]);
    await demand(pageId, reg, "dm-conversations.head");
    const holdUntil = new Date(Date.now() + 60_000);
    expect(await writeSyncRouteState(db(), {
      pageId, route: "messaging.groups", expectRevision: 0,
      entry: entryWrite({ holdUntil, effectivePerMin: 6, policyVersion: routePolicyVersion("messaging.groups") }),
    })).toEqual({ kind: "written", revision: 1 });
    const page = (await getSyncPage(db(), pageId))!;
    const [why] = await explainSyncWork(db(), testConfig(testDb.connectionString), page, { resource: "dm-conversations.head" });
    expect(why!.waiting).toEqual({
      reason: "route_hold", until: holdUntil, detail: { routes: ["messaging.groups"], held: ["messaging.groups"] },
    });
    // On the wire (`sync why`, the agent and owner routes): the reason and its deadline.
    expect(toSyncWorkWire(why!)).toMatchObject({ waitingReason: "route_hold", waitingUntil: holdUntil.toISOString() });
    // The hold over, the halved route's own pace is what the key waits for —
    // never named a hold.
    await writeSyncRouteState(db(), {
      pageId, route: "messaging.groups", expectRevision: 1,
      entry: entryWrite({ holdUntil: new Date(Date.now() - 1_000), effectivePerMin: 6, policyVersion: routePolicyVersion("messaging.groups") }),
    });
    await testDb.pool.query(
      `insert into sync_attempts (page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                  admitted_at, sent_at, send_mark, operation, request, outcome)
       values ($1, false, 'dm-conversations.head', '', 'urgent', 1, 2000, 0, 2000, clock_timestamp(), clock_timestamp(),
               'request_start', 'messaging.groups', '{}'::jsonb, 'response')`,
      [pageId],
    );
    const [paced] = await explainSyncWork(db(), testConfig(testDb.connectionString), (await getSyncPage(db(), pageId))!, { resource: "dm-conversations.head" });
    expect(paced!.waiting).toMatchObject({ reason: "route_budget", detail: { routes: ["messaging.groups"] } });
  }, 60_000);
});

describe("the route state writer", () => {
  it("is a compare-and-set on the route's revision; the route's state and its hold are rows of the page's hold set", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLive();
    const write = (expectRevision: number, overrides: Partial<SyncRouteStateEntryWrite> = {}) =>
      writeSyncRouteState(db(), { pageId, route: "messages.page", expectRevision, entry: entryWrite(overrides) });
    expect(await write(0)).toEqual({ kind: "written", revision: 1 });
    expect(await write(0)).toEqual({ kind: "stale" });
    const holdUntil = new Date(Date.now() + 60_000);
    expect(await write(1, { effectivePerMin: 3.75, ladderStep: 2, holdUntil })).toEqual({ kind: "written", revision: 2 });
    // Another route is its own rows.
    expect(await writeSyncRouteState(db(), { pageId, route: "polls", expectRevision: 0, entry: entryWrite() }))
      .toEqual({ kind: "written", revision: 1 });
    const page = (await getSyncPage(db(), pageId))!;
    expect(page.holds.map((row) => [row.scope, row.key, row.kind, row.ladderStep, row.revision])).toEqual([
      ["route", "messages.page", "route_budget", 2, 2],
      ["route", "messages.page", "route_hold", 0, 1],
      ["route", "polls", "route_budget", 1, 1],
    ]);
    expect(page.holds[0]!.until).toBeNull();
    expect(page.holds[1]!.until).toEqual(holdUntil);
    expect(routeEntryOf(page, "messages.page")).toMatchObject({ effectivePerMin: 3.75, ladderStep: 2, revision: 2, holdUntil: holdUntil.toISOString() });
    expect(routeEntryOf(page, "polls")).toMatchObject({ revision: 1, holdUntil: null });
    // A write without a hold's end lifts the route's hold row; the state stays.
    expect(await write(2, { effectivePerMin: 3.75, ladderStep: 2 })).toEqual({ kind: "written", revision: 3 });
    expect(routeEntryOf((await getSyncPage(db(), pageId))!, "messages.page")).toMatchObject({ holdUntil: null, effectivePerMin: 3.75, revision: 3 });
    // A lost generation is an ownership loss, not a stale write.
    await expect(writeSyncRouteState(db(), {
      pageId, generation: 999n, route: "messages.page", expectRevision: 3, entry: entryWrite(),
    })).rejects.toThrow(/no longer owns/);
  }, 60_000);
});

describe("sync route raise (A2)", () => {
  function cli(lines: string[]) {
    return buildSyncEngineCommandGroup({
      openContext: async () => ({ db: db(), rawConfig: testConfig(testDb!.connectionString), close: async () => undefined }),
      print: (line) => lines.push(line),
    });
  }

  const raise = (lines: string[], label: string, route: string, to: string, revision: string) =>
    cli(lines).parseAsync(["node", "sync", "route", "raise", "--page", label, "--route", route, "--to", to, "--revision", revision,
      "--evidence", "budgets-calibration since 2026-10-04T00:00:00Z: 2 × 2 h saturated, 0 × 429"]);

  async function raises(pageId: number) {
    const result = await testDb!.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where event_type = $1 and platform_account_id = $2 order by id", [SYNC_ROUTE_RAISE_AUDIT_EVENT, pageId],
    );
    return result.rows.map((row) => row.metadata);
  }

  it("one audited step of at most +1/min against the evidence's revision; the hold in force stays; current ends the slowdown", async (context) => {
    if (!testDb) return context.skip();
    const label = "raise-1";
    const pageId = await seedLive(label);
    const holdUntil = new Date(Date.now() + 120_000);
    await writeSyncRouteState(db(), { pageId, route: "messages.page", expectRevision: 0, entry: entryWrite() });
    await writeSyncRouteState(db(), {
      pageId, route: "messages.page", expectRevision: 1, entry: entryWrite({ holdUntil, effectivePerMin: 3.75, ladderStep: 2 }),
    });

    // A stale revision (a 429 after the evidence), a step above +1/min, a route not in the catalogue: refused, nothing written.
    await expect(raise([], label, "messages.page", "4.75", "1")).rejects.toThrow(/stale_revision/);
    await expect(raise([], label, "messages.page", "5", "2")).rejects.toThrow(/step_too_large/);
    await expect(raise([], label, "messages.nope", "5", "2")).rejects.toThrow(/No Fansly route/);
    expect(await raises(pageId)).toEqual([]);

    const lines: string[] = [];
    await raise(lines, label, "messages.page", "4.75", "2");
    expect(JSON.parse(lines.join("\n"))).toEqual({
      page: label, route: "messages.page", fromPerMin: 3.75, toPerMin: 4.75, currentPerMin: 15, ceilingPerMin: 15,
      revision: 3, slowdownEnded: false, holdUntil: holdUntil.toISOString(),
    });
    expect(await entryOf(pageId, "messages.page")).toMatchObject({
      effectivePerMin: 4.75, ladderStep: 2, holdUntil: holdUntil.toISOString(), revision: 3,
    });
    expect(await raises(pageId)).toEqual([expect.objectContaining({
      route: "messages.page", fromPerMin: 3.75, toPerMin: 4.75, fromRevision: 2, revision: 3, slowdownEnded: false,
      evidence: expect.stringContaining("budgets-calibration"),
    })]);
    // The same evidence twice: its revision is gone.
    await expect(raise([], label, "messages.page", "5.75", "2")).rejects.toThrow(/stale_revision/);

    // The last step reaches current: the slowdown is over, the ladder starts over on the next 429.
    await writeSyncRouteState(db(), {
      pageId, route: "messages.page", expectRevision: 3, entry: entryWrite({ holdUntil, effectivePerMin: 14, ladderStep: 2 }),
    });
    const last: string[] = [];
    await raise(last, label, "messages.page", "15", "4");
    expect(JSON.parse(last.join("\n"))).toMatchObject({ toPerMin: 15, slowdownEnded: true, revision: 5 });
    expect(await entryOf(pageId, "messages.page")).toMatchObject({ effectivePerMin: null, policyVersion: null, revision: 5 });
    await expect(raise([], label, "messages.page", "15", "5")).rejects.toThrow(/not_slowed/);
  }, 60_000);
});
