import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSyncPage, upsertDemand, type Database } from "@agency_hub_core/db";
import type { FanslyWireId, FanslyWireOutcome } from "@agency_hub_core/fansly";

import { createEngineRegistry, type EngineRegistry, type EngineResourceSpec, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { intervalMsOf, routePolicyVersion, type FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";
import { readSyncPageStatus } from "../apps/runtime/src/sync/inspect.ts";
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
import { routeEntryOf } from "./helpers/sync-holds.ts";

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
  await upsertDemand(db(), { pageId, resource, subject: "", kind: spec.kind, class: spec.class, demand: { reasons: ["test"] } });
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
    db: db(), pageId, registry: reg, routeTimeScale: options.scale, transport,
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
    // The ladder's first step, stretched by the actor's jitter draw (0.5 → 10 %),
    // from the moment the actor took the answer, on its own clock (the
    // entry's last429At) — after the refusal went out. Not from completed_at:
    // the database stamps it (clock_timestamp(), another clock) inside the
    // capture's transaction, after the actor read its clock — under load
    // tens of ms after (a 2 s hold measured 1946 ms from it).
    const holdUntil = new Date(entry.holdUntil!).getTime();
    const answeredAt = new Date(entry.last429At!).getTime();
    expect(holdUntil - answeredAt).toBe(5_500);
    expect(answeredAt).toBeGreaterThanOrEqual(refusal!.sent_at.getTime());
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
    // The Retry-After to the letter, from the moment the actor took the answer.
    expect(new Date(next.holdUntil!).getTime() - new Date(next.last429At!).getTime()).toBe(1_000);
    expect(new Date(next.last429At!).getTime()).toBeGreaterThanOrEqual(second.sent_at.getTime());
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
});
