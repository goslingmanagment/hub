import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { agentHistoryRequestSchema } from "@agency_hub_core/contracts";
import { upsertFans, writeThreadChain, type Database } from "@agency_hub_core/db";

import { ROUTE_STATE_VERSION, type RouteStateEntry } from "../apps/runtime/src/sync/engine/route-policy.ts";
import {
  getHistoryRequest,
  submitHistoryRequest,
  type HistoryIntake,
  type HistoryServiceContext,
} from "../apps/runtime/src/sync/requests/history.ts";
import { toHistoryRequestWire } from "../apps/runtime/src/sync/requests/wire.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedSyncPage, testConfig } from "./helpers/sync-engine-host.ts";

// A history request's ETA against a real database (step 3b ruling 11, owner
// decision №24): the rate is the messaging family's 15/min less what the
// urgent and planned classes sent on it over the last 15 minutes of
// `sync_attempts` (an unknown outcome counts, a refusal before sending and an
// older send do not, the class's own reads are not subtracted); a slowdown of
// `/message` after a 429 sets the rate on its route and is shown; a hold —
// the route's own, the page's, or a route state this build cannot read —
// stops the reads and is shown beside the estimate, not in it; k requests
// share the class; and `estimate_at_submit` is written once and never again.
// The model itself: tests/sync-history-eta.test.ts, against the actor:
// tests/sync-history-eta-sim.test.ts.

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

function ctx(): HistoryServiceContext {
  return { db: db(), rawConfig: testConfig(testDb!.connectionString) };
}

async function rows<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query<T>(text, values)).rows;
}

const EPOCH_MS = 1561494359900;
const HOUR = 3_600_000;
const BASE_MS = Date.now() - 30 * 24 * HOUR;
const snowflake = (ms: number) => (BigInt(ms - EPOCH_MS) << 22n).toString();
const msg = (k: number) => snowflake(BASE_MS + k * 60_000);
const group = (n: number) => snowflake(BASE_MS - n * 1000);
const fan = (n: number) => `52000000000000${String(n).padStart(4, "0")}`;

/** A live page open to requests, with a beating owner. */
async function livePage(): Promise<number> {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
  await testDb!.pool.query(
    `update sync_pages set requests_enabled_at = clock_timestamp() - interval '1 minute',
            owner_generation = owner_generation + 1, owner_host = 'sync-test',
            owner_acquired_at = clock_timestamp() - interval '1 hour', owner_heartbeat_at = clock_timestamp()
      where page_id = $1`,
    [pageId],
  );
  return pageId;
}

/** A chat with 50 stored messages proven as a partial chain. */
async function seedThread(pageId: number, n: number): Promise<void> {
  const [fanRow] = await upsertFans(db(), [{ platform: "fansly" as const, platformUserId: fan(n) }]);
  const [thread] = await rows<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
            stored_message_count, newest_stored_message_id, oldest_stored_message_id, message_coverage_status, is_visible,
            last_message_at, metadata)
     values ($1, $2, $3, $4, 50, $5, $6, 'partial_window', true, now(), '{}'::jsonb)
     returning id::text as id`,
    [pageId, group(n), fanRow!.id, fan(n), msg(50), msg(1)],
  );
  await db().transaction(async (tx) => {
    await writeThreadChain(tx as unknown as Database, Number(thread!.id), {
      chain: {
        epoch: 0, state: "partial", headId: msg(50), headAt: new Date(Date.now() - HOUR), oldestId: msg(1),
        oldestCreatedAtMs: BASE_MS + 60_000, count: 50, upwardCount: 0, proof: null, proofWitness: null, provenAt: null,
      },
      source: "journal_rebuild",
    });
  });
}

function intake(pageId: number, threads: number[]): HistoryIntake {
  return {
    pageId,
    requester: { kind: "owner_cli", userId: null },
    fans: threads.map((n) => ({ kind: "conversation" as const, conversationRef: group(n) })),
    depth: { kind: "all" },
    reason: "eta",
    idempotencyKey: randomUUID(),
  };
}

/** `count` attempts of the page's live journal, one every `everySeconds`,
 *  the newest `secondsAgo` ago. `sent: false`: no send was recorded. */
async function journal(pageId: number, input: {
  workClass: "urgent" | "requests" | "planned";
  operation: string;
  count: number;
  secondsAgo: number;
  everySeconds: number;
  outcome?: "response" | "unknown" | "aborted_before_send";
}): Promise<void> {
  const outcome = input.outcome ?? "response";
  const sent = outcome === "response";
  await testDb!.pool.query(
    `insert into sync_attempts (page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                admitted_at, sent_at, send_mark, operation, request, outcome)
     select $1, false, 'test.' || $3, '', $2, 1, 2500, 0, 2500,
            clock_timestamp() - make_interval(secs => $4::double precision + g * $5::double precision + 0.1),
            case when $7::boolean then clock_timestamp() - make_interval(secs => $4::double precision + g * $5::double precision) end,
            case when $7::boolean then 'request_start' end,
            $3, '{}'::jsonb, $8
       from generate_series(0, $6::int - 1) g`,
    [pageId, input.workClass, input.operation, input.secondsAgo, input.everySeconds, input.count, sent, outcome],
  );
}

/** The other classes of an ordinary busy quarter hour: 1 confirmation and 1
 *  list read a minute on the messaging family, the media walk at 5/min. */
async function busyQuarter(pageId: number): Promise<void> {
  await journal(pageId, { workClass: "urgent", operation: "messages.page", count: 14, secondsAgo: 30, everySeconds: 60 });
  // An outcome never learnt consumes budget; a refusal before the send and a
  // send before the window do not.
  await journal(pageId, { workClass: "urgent", operation: "messages.page", count: 1, secondsAgo: 5, everySeconds: 1, outcome: "unknown" });
  await journal(pageId, { workClass: "urgent", operation: "messages.page", count: 5, secondsAgo: 10, everySeconds: 1, outcome: "aborted_before_send" });
  await journal(pageId, { workClass: "urgent", operation: "group.detail", count: 10, secondsAgo: 16 * 60, everySeconds: 10 });
  await journal(pageId, { workClass: "planned", operation: "messaging.groups", count: 15, secondsAgo: 20, everySeconds: 59 });
  await journal(pageId, { workClass: "planned", operation: "media.offer_stats", count: 75, secondsAgo: 3, everySeconds: 11.9 });
  // The class's own reads are what it gets, never subtracted from it.
  await journal(pageId, { workClass: "requests", operation: "messages.page", count: 150, secondsAgo: 1, everySeconds: 5.9 });
}

async function setRouteState(pageId: number, value: unknown): Promise<void> {
  await testDb!.pool.query(
    "update sync_pages set resource_holds = jsonb_set(resource_holds, '{route:state}', $2::jsonb) where page_id = $1",
    [pageId, JSON.stringify(value)],
  );
}

function messagesEntry(overrides: Partial<RouteStateEntry>): RouteStateEntry {
  return {
    holdUntil: null, ladderStep: 0, effectivePerMin: null, policyVersion: null,
    last429AttemptId: null, last429At: null, revision: 1,
    ...overrides,
  };
}

async function storedEstimate(ref: string): Promise<unknown> {
  const [row] = await rows<{ estimate: unknown }>(
    "select estimate_at_submit as estimate from history_requests where request_ref = $1::uuid",
    [ref],
  );
  return row!.estimate;
}

describe("a request's rate is its page's budgets less the other classes' use (step 3b ruling 11)", () => {
  it("the messaging family's 15/min less a confirmation and a list read a minute: 780 reads an hour", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage();
    await seedThread(pageId, 1);
    await busyQuarter(pageId);
    const { request } = await submitHistoryRequest(ctx(), intake(pageId, [1]));
    expect(request.eta).toMatchObject({ limitedBy: "family", ratePerHour: 780, slowdown: null, hold: null, basis: "estimate" });
    // The page's slots at S = 2.5 s (≈ 21.8 a minute): the urgent class keeps
    // its 1, the planned walks 1 of 5 of the rest, the class 4 of 5.
    expect(request.eta.sharePercent).toBe(Math.round((0.8 * (60_000 / 2_750 - 1)) / (60_000 / 2_750) * 100));
    // One read every 60/13 s.
    expect(request.eta.lowerBoundSeconds).toBe(Math.ceil(Math.round(request.reads.remainingMin * (60_000 / 13)) / 1000));
    expect(request.waitingReason).toBeNull();
    expect(agentHistoryRequestSchema.safeParse(toHistoryRequestWire(request)).success).toBe(true);
    expect(await storedEstimate(request.ref)).toMatchObject({
      ratePerHour: 780, limitedBy: "family", k: 1, settingMs: 2_500, slowdown: null, hold: null,
      readsMin: request.reads.remainingMin, etaMinMs: Math.round(request.reads.remainingMin * (60_000 / 13)),
    });
  });

  it("a quiet page reads at the family's full 15/min; a second request halves each one's rate", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage();
    for (const n of [1, 2]) await seedThread(pageId, n);
    const first = await submitHistoryRequest(ctx(), intake(pageId, [1]));
    expect(first.request.eta).toMatchObject({ limitedBy: "family", ratePerHour: 900, sharePercent: 100 });
    const second = await submitHistoryRequest(ctx(), intake(pageId, [2]));
    expect(second.request.eta.ratePerHour).toBe(450);
    expect((await getHistoryRequest(ctx(), first.request.ref)).request.eta.ratePerHour).toBe(450);
    // The first request's forecast stays as it was given.
    expect(await storedEstimate(first.request.ref)).toMatchObject({ ratePerHour: 900, k: 1 });
    expect(await storedEstimate(second.request.ref)).toMatchObject({ ratePerHour: 450, k: 2 });
  });
});

describe("holds and slowdowns are shown apart; the estimate at submit is never rewritten", () => {
  it("`/message` at half after a 429 sets the rate on its route; its hold stops the reads and waits the request", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage();
    await seedThread(pageId, 1);
    await busyQuarter(pageId);
    const filed = await submitHistoryRequest(ctx(), intake(pageId, [1]));
    const atSubmit = await storedEstimate(filed.request.ref);
    expect(filed.request.estimateAtSubmit).toEqual(atSubmit);

    const holdUntil = new Date(Date.now() + 5 * 60_000).toISOString();
    await setRouteState(pageId, {
      version: ROUTE_STATE_VERSION,
      routes: { "messages.page": messagesEntry({ holdUntil, ladderStep: 2, effectivePerMin: 7.5, last429AttemptId: 1, last429At: new Date().toISOString() }) },
    });
    const held = await getHistoryRequest(ctx(), filed.request.ref);
    expect(held.request.eta).toMatchObject({
      // 7.5/min less the urgent class's 1/min on /message: 6.5/min.
      limitedBy: "route",
      ratePerHour: 390,
      slowdown: { route: "messages.page", effectivePerMin: 7.5, currentPerMin: 15 },
      hold: { scope: "route", until: holdUntil },
    });
    // The hold is not in the seconds: they are the reads at 6.5/min.
    expect(held.request.eta.lowerBoundSeconds).toBe(Math.ceil(Math.round(held.request.reads.remainingMin * (60_000 / 6.5)) / 1000));
    expect(held.request).toMatchObject({ waitingReason: "pacer", waitingUntil: holdUntil });
    // The fan's chat waits on its route like any work.
    expect(held.items[0]).toMatchObject({ waitingReason: "pacer", waitingUntil: holdUntil });
    expect(agentHistoryRequestSchema.safeParse(toHistoryRequestWire(held.request)).success).toBe(true);

    // The hold over, the slowdown stays (only a deliberate step lifts it).
    await setRouteState(pageId, {
      version: ROUTE_STATE_VERSION,
      routes: { "messages.page": messagesEntry({ holdUntil: new Date(Date.now() - 1_000).toISOString(), effectivePerMin: 7.5, revision: 2 }) },
    });
    const slowed = await getHistoryRequest(ctx(), filed.request.ref);
    expect(slowed.request.eta).toMatchObject({ limitedBy: "route", ratePerHour: 390, hold: null, slowdown: { effectivePerMin: 7.5 } });
    expect(slowed.request.waitingReason).toBeNull();

    // Neither touched the forecast given at submit.
    expect(slowed.request.estimateAtSubmit).toEqual(atSubmit);
    expect(await storedEstimate(filed.request.ref)).toEqual(atSubmit);
  });

  it("a page hold is the page's; a route state this build cannot read stops the page with no end", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage();
    await seedThread(pageId, 1);
    const filed = await submitHistoryRequest(ctx(), intake(pageId, [1]));
    await testDb.pool.query(
      `update sync_pages set hold_kind = 'rate_limit', hold_until = clock_timestamp() + interval '2 minutes',
              hold_since = clock_timestamp() where page_id = $1`,
      [pageId],
    );
    const [held] = await rows<{ until: Date }>("select hold_until as until from sync_pages where page_id = $1", [pageId]);
    const until = held!.until.toISOString();
    const pageHeld = await getHistoryRequest(ctx(), filed.request.ref);
    expect(pageHeld.request.eta).toMatchObject({ hold: { scope: "page", until }, ratePerHour: 900 });
    expect(pageHeld.request).toMatchObject({ waitingReason: "page_hold", waitingUntil: until });

    await testDb.pool.query("update sync_pages set hold_kind = null, hold_until = null, hold_since = null where page_id = $1", [pageId]);
    await setRouteState(pageId, { version: ROUTE_STATE_VERSION + 1, routes: {} });
    const unreadable = await getHistoryRequest(ctx(), filed.request.ref);
    expect(unreadable.request.eta.hold).toEqual({ scope: "page", until: null });
    expect(unreadable.request).toMatchObject({ waitingReason: "page_hold", waitingUntil: null });
    expect(agentHistoryRequestSchema.safeParse(toHistoryRequestWire(unreadable.request)).success).toBe(true);
    expect(await storedEstimate(filed.request.ref)).toMatchObject({ hold: null, ratePerHour: 900 });
  });

  it("a hold in force at submit is kept beside the forecast, not in it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage();
    await seedThread(pageId, 1);
    const holdUntil = new Date(Date.now() + 60_000).toISOString();
    await setRouteState(pageId, { version: ROUTE_STATE_VERSION, routes: { "messages.page": messagesEntry({ holdUntil }) } });
    const { request } = await submitHistoryRequest(ctx(), intake(pageId, [1]));
    expect(request.eta).toMatchObject({ ratePerHour: 900, slowdown: null, hold: { scope: "route", until: holdUntil } });
    expect(await storedEstimate(request.ref)).toMatchObject({
      ratePerHour: 900, hold: { scope: "route", until: holdUntil },
      etaMinMs: request.reads.remainingMin * 4_000,
    });
  });
});
